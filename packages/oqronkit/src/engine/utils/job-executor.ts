import { HeartbeatWorker } from "../lock/heartbeat-worker.js";
import type { Logger } from "../logger/index.js";
import type { OqronJob } from "../types/job.types.js";
import type { QueueJobContext } from "../../queue/types.js";
import type { OqronContainer } from "../container.js";
import { OqronEventBus } from "../events/event-bus.js";
import { calculateBackoff } from "./backoffs.js";
import { DependencyResolver } from "./dependency-resolver.js";
import { pruneAfterCompletion } from "./job-retention.js";
import type { RemoveOnConfig } from "../types/job.types.js";

// ── Shared configuration shape ──────────────────────────────────────────────
// Both QueueConfig and WorkerConfig expose overlapping execution settings.
// This interface captures only the fields needed by the execution loop.

export interface JobHandlerConfig {
  /** Queue/topic name used in Broker operations */
  name: string;
  /** The handler function to execute */
  handler: (ctx: QueueJobContext<any>) => Promise<any>;
  /** Enable crash-safe heartbeat locks. @default true */
  guaranteedWorker?: boolean;
  /** Heartbeat polling interval in ms */
  heartbeatMs?: number;
  /** Lock TTL in ms */
  lockTtlMs?: number;
  /** Execution timeout in ms */
  timeout?: number;
  /** Tags for categorization */
  tags?: string[];
  /** Retry configuration */
  retries?: {
    max?: number;
    strategy?: "fixed" | "exponential";
    baseDelay?: number;
    maxDelay?: number;
  };
  /** Pre-execution rate limiter */
  rateLimiter?: { check(ctx: any): Promise<{ allowed: boolean }> };
  /** DLQ hooks */
  deadLetter?: {
    enabled?: boolean;
    onDead?: (job: OqronJob) => Promise<void>;
  };
  /** Lifecycle hooks */
  hooks?: {
    beforeRun?: (ctx: QueueJobContext) => Promise<void> | void;
    onSuccess?: (job: OqronJob, result: any) => Promise<void> | void;
    onFail?: (job: OqronJob, error: Error) => Promise<void> | void;
  };
  /** Auto-remove completed jobs */
  removeOnComplete?: RemoveOnConfig;
  /** Auto-remove failed jobs */
  removeOnFail?: RemoveOnConfig;
}

// ── Module-level defaults (from the `queue` or `worker` module definition) ──

export interface ModuleLevelDefaults {
  heartbeatMs?: number;
  lockTtlMs?: number;
  retries?: {
    max?: number;
    strategy?: "fixed" | "exponential";
    baseDelay?: number;
    maxDelay?: number;
  };
  deadLetter?: { enabled?: boolean };
  removeOnComplete?: RemoveOnConfig;
  removeOnFail?: RemoveOnConfig;
  shutdownTimeout?: number;
}

// ── Execution context passed into the executor ──────────────────────────────

export interface JobExecutionContext {
  /** The DI container */
  di: OqronContainer;
  /** Logger instance */
  logger: Logger;
  /** Unique worker identifier */
  workerId: string;
  /** Global config: environment */
  environment: string;
  /** Global config: project */
  project: string;
  /** Per-handler config (resolved from QueueConfig or WorkerConfig) */
  handlerConfig: JobHandlerConfig;
  /** Module-level defaults (from QueueModuleDef or WorkerModuleDef) */
  moduleDefaults: ModuleLevelDefaults;
  /** Active heartbeats map — mutated by executor */
  heartbeats: Map<string, HeartbeatWorker>;
  /** Active abort controllers — mutated by executor */
  abortControllers: Map<string, AbortController>;
  /** Lock key prefix for the module (e.g. "queue" or "worker") */
  lockPrefix: string;
}

/** Maximum timeline entries per job before trimming oldest entries (JE1) */
const MAX_TIMELINE_ENTRIES = 100;

/**
 * Shared job execution logic used by both QueueEngine and WorkerEngine.
 *
 * This function handles the complete lifecycle of a claimed job:
 * 1. Heartbeat lock acquisition
 * 2. Context construction (progress, log, discard, signal)
 * 3. Hook execution (beforeRun)
 * 4. Handler invocation with timeout support
 * 5. Retry / nack / DLQ logic
 * 6. Finalization (status, duration, latency, timeline)
 * 7. EventBus emissions and hooks
 * 8. Job retention pruning
 */
export async function executeJob(
  job: OqronJob,
  ctx: JobExecutionContext,
): Promise<void> {
  const { di, logger, workerId, handlerConfig: hc, moduleDefaults: md } = ctx;
  let internalDiscarded = false;

  const lockTtlMs = hc.lockTtlMs ?? md.lockTtlMs ?? 30000;
  const heartbeatMs = hc.heartbeatMs ?? md.heartbeatMs ?? 5000;
  const useGuaranteed = hc.guaranteedWorker !== false;

  // Resolve retry config: per-handler → module-level → default
  const maxRetries = hc.retries?.max ?? md.retries?.max ?? 0;
  const retryStrategy =
    hc.retries?.strategy ?? md.retries?.strategy ?? "exponential";
  const baseDelay =
    hc.retries?.baseDelay ?? md.retries?.baseDelay ?? 2000;
  const maxDelay =
    hc.retries?.maxDelay ?? md.retries?.maxDelay ?? 60000;

  // Per-job attempts override takes highest priority
  const effectiveMaxRetries = job.opts?.attempts
    ? job.opts.attempts - 1
    : maxRetries;

  // ── Set moduleName unconditionally on the job record ───────────────────
  job.moduleName = job.moduleName ?? hc.name;

  // ── Apply tags from handler config if job tags are empty ───────────────
  if ((!job.tags || job.tags.length === 0) && hc.tags) {
    job.tags = [...hc.tags];
  }

  // ── Start HeartbeatWorker for crash-safe lock renewal ─────────────────
  let heartbeat: HeartbeatWorker | null = null;
  if (useGuaranteed) {
    const lockKey = `${ctx.lockPrefix}:job:${job.id}`;
    heartbeat = new HeartbeatWorker(
      di.lock,
      logger,
      lockKey,
      workerId,
      lockTtlMs,
      heartbeatMs,
    );
    const acquired = await heartbeat.start();
    if (!acquired) {
      logger.warn(`Failed to acquire heartbeat lock for job ${job.id}`);
      await di.broker.nack(hc.name, job.id);
      return;
    }
    ctx.heartbeats.set(job.id, heartbeat);
  }

  // ── Create AbortController for cancellation support ────────────────────
  const abortController = new AbortController();
  ctx.abortControllers.set(job.id, abortController);

  // Compute max attempts for context
  const maxAttempts = effectiveMaxRetries + 1;

  const jobCtx: QueueJobContext<any> = {
    id: job.id,
    name: hc.name,
    data: job.data,
    signal: abortController.signal,
    get aborted() { return abortController.signal.aborted; },
    environment: job.environment ?? ctx.environment,
    project: job.project ?? ctx.project,
    attempt: (job.attemptMade ?? 0) + 1,
    maxAttempts,
    createdAt: job.createdAt ? new Date(job.createdAt) : new Date(),
    progress: async (percent, label) => {
      job.progressPercent = percent;
      job.progressLabel = label;
      if (!job.timeline) job.timeline = [];
      pushTimeline(job, {
        ts: new Date(),
        from: "active",
        to: "active",
        reason: `Progress: ${percent}% ${label || ""}`,
      });
      await di.storage.save("jobs", job.id, job);
      OqronEventBus.emit("job:progress", job.queueName, job.id, percent);
    },
    log: (level, msg) => {
      const method = logger[level] || logger.info;
      method.call(logger, `[${ctx.lockPrefix}:${hc.name}] ${msg}`, {
        jobId: job.id,
      });
      if (!job.logs) job.logs = [];
      job.logs.push({ level, msg, ts: new Date() });
      // Best effort async save for logs without blocking execution
      di.storage.save("jobs", job.id, job).catch(() => {});
    },
    discard: () => {
      internalDiscarded = true;
    },
  };

  // Update state to active
  const oldStatus = job.status;
  job.status = "active";
  job.workerId = workerId;
  job.startedAt = new Date();
  job.processedOn = new Date();
  job.attemptMade = (job.attemptMade ?? 0) + 1;
  if (!job.timeline) job.timeline = [];
  pushTimeline(job, {
    ts: job.startedAt,
    from: oldStatus,
    to: "active",
    reason: `Worker ${workerId} claimed job`,
  });
  await di.storage.save("jobs", job.id, job);

  OqronEventBus.emit("job:start", job.queueName, job.id, hc.name);

  let status: "completed" | "failed" = "completed";
  let error: string | undefined;
  let result: any;

  try {
    // ── Pre-execution: rate limiter check ──────────────────────────────
    if (hc.rateLimiter) {
      const rlResult = await hc.rateLimiter.check(jobCtx).catch(() => ({ allowed: true }));
      if (!rlResult.allowed) {
        logger.info(`Job ${job.id} rate-limited, nacking back to broker`);
        // Stop heartbeat before nack
        if (heartbeat) {
          await heartbeat.stop();
          ctx.heartbeats.delete(job.id);
        }
        ctx.abortControllers.delete(job.id);
        // Restore state
        job.status = oldStatus;
        await di.storage.save("jobs", job.id, job);
        await di.broker.nack(hc.name, job.id, 1000); // Small delay before retry
        return;
      }
    }

    // ── Pre-execution: beforeRun hook ──────────────────────────────────
    if (hc.hooks?.beforeRun) {
      await hc.hooks.beforeRun(jobCtx);
    }

    let timeoutHandle: any;
    const executePromise = hc.handler(jobCtx);

    if (typeof hc.timeout === "number") {
      const timeoutPromise = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
          abortController.abort();
          const err = new Error(`Job exceeded timeout of ${hc.timeout}ms`);
          err.name = "TimeoutError";
          reject(err);
        }, hc.timeout);
      });

      result = await Promise.race([executePromise, timeoutPromise]);
    } else {
      result = await executePromise;
    }

    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }

    if (internalDiscarded) {
      throw new Error("Job discarded by handler");
    }

    // Check if we were cancelled mid-execution
    if (abortController.signal.aborted) {
      throw new Error("Cancelled");
    }

    status = "completed";
    error = undefined;
  } catch (e: any) {
    error = e.message ?? "Unknown error";
    status = "failed";

    // Capture stacktrace
    job.stacktrace = e.stack ? [e.stack] : [];

    // If cancelled, don't retry
    if (abortController.signal.aborted) {
      logger.info(`Job ${job.id} was cancelled`);
    }
    // Check if we should retry via nack (broker-level, crash-safe)
    else if (!internalDiscarded && job.attemptMade <= effectiveMaxRetries) {
      const backoffOpts = job.opts?.backoff ?? {
        type: retryStrategy,
        delay: baseDelay,
      };
      const delay = calculateBackoff(backoffOpts, job.attemptMade, maxDelay);

      logger.warn("Job failed, re-queuing for retry...", {
        name: hc.name,
        jobId: job.id,
        attempt: job.attemptMade,
        nextIn: `${delay}ms`,
        error,
      });

      // Mark as delayed in storage so dashboards see the correct state
      job.status = "delayed";
      job.error = error;
      await di.storage.save("jobs", job.id, job);

      // Stop heartbeat before nack
      if (heartbeat) {
        await heartbeat.stop();
        ctx.heartbeats.delete(job.id);
      }

      // Clean up abort controller
      ctx.abortControllers.delete(job.id);

      // Nack back to broker with delay — crash-safe
      await di.broker.nack(hc.name, job.id, delay);
      return; // Exit — the job will be re-claimed on the next poll cycle
    }

    // All retries exhausted
    logger.error("Job failed permanently", {
      name: hc.name,
      jobId: job.id,
      attempts: job.attemptMade,
      error,
    });
  }

  // ── Clean up abort controller ────────────────────────────────────────
  ctx.abortControllers.delete(job.id);

  // ── Stop heartbeat ──────────────────────────────────────────────────
  if (heartbeat) {
    await heartbeat.stop();
    ctx.heartbeats.delete(job.id);
  }

  // ── Finalize ─────────────────────────────────────────────────────────
  const finishedAt = new Date();
  job.status = status;
  job.finishedAt = finishedAt;
  job.error = error;

  if (status === "completed") {
    job.returnValue = result;
    job.progressPercent = 100;
    job.progressLabel = "Completed";
  }

  // Compute duration
  if (job.startedAt) {
    job.durationMs = finishedAt.getTime() - new Date(job.startedAt).getTime();
  }

  // JE2: Compute latency (time from queued to started)
  if (job.queuedAt && job.startedAt) {
    job.latencyMs = new Date(job.startedAt).getTime() - new Date(job.queuedAt).getTime();
  }

  if (!job.timeline) job.timeline = [];
  pushTimeline(job, {
    ts: finishedAt,
    from: "active",
    to: status,
    reason: status === "failed" ? error : "Finished successfully",
  });

  await di.storage.save("jobs", job.id, job);
  await di.broker.ack(hc.name, job.id);

  // ── Notify dependent children ────────────────────────────────────
  if (job.childrenIds?.length) {
    await DependencyResolver.notifyChildren(
      di.storage,
      di.broker,
      job.id,
    );
  }

  // ── EventBus emissions ──────────────────────────────────────────────
  if (status === "completed") {
    OqronEventBus.emit("job:success", job.queueName, job.id);

    if (hc.hooks?.onSuccess) {
      void Promise.resolve()
        .then(() => hc.hooks!.onSuccess!(job as OqronJob, result))
        .catch((e) =>
          logger.error("onSuccess hook failed", { err: String(e) }),
        );
    }
  } else {
    const errorObject = new Error(error ?? "Unknown error");
    OqronEventBus.emit("job:fail", job.queueName, job.id, errorObject);

    if (hc.hooks?.onFail) {
      void Promise.resolve()
        .then(() => hc.hooks!.onFail!(job as OqronJob, errorObject))
        .catch((e) =>
          logger.error("onFail hook failed", { err: String(e) }),
        );
    }

    // DLQ: invoke dead letter hook if enabled and retries exhausted
    const dlqEnabled =
      hc.deadLetter?.enabled ?? md.deadLetter?.enabled;
    if (dlqEnabled && hc.deadLetter?.onDead) {
      void Promise.resolve().then(() =>
        hc.deadLetter!.onDead!(job as OqronJob).catch((e) =>
          logger.error("DLQ handler failed", { err: String(e) }),
        ),
      );
    }
  }

  // ── Job Retention / Pruning ──────────────────────────────────────────
  await pruneAfterCompletion({
    namespace: "jobs",
    jobId: job.id,
    status,
    jobRemoveConfig:
      status === "completed"
        ? job.opts?.removeOnComplete
        : job.opts?.removeOnFail,
    moduleRemoveConfig:
      status === "completed" ? hc.removeOnComplete : hc.removeOnFail,
    globalRemoveConfig:
      status === "completed" ? md.removeOnComplete : md.removeOnFail,
    filterKey: "queueName",
    filterValue: hc.name,
  });
}

// ── JE1: Timeline entry helper with cap ─────────────────────────────────────

function pushTimeline(
  job: OqronJob,
  entry: { ts: Date; from: string; to: string; reason?: string },
): void {
  if (!job.timeline) job.timeline = [];
  job.timeline.push(entry);

  // Cap timeline entries to prevent unbounded growth
  if (job.timeline.length > MAX_TIMELINE_ENTRIES) {
    job.timeline = job.timeline.slice(job.timeline.length - MAX_TIMELINE_ENTRIES);
  }
}
