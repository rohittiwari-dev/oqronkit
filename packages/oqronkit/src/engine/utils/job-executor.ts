import { randomUUID } from "node:crypto";
import type { QueueJobContext } from "../../queue/types.js";
import type { OqronContainer } from "../container.js";
import { OqronEventBus } from "../events/event-bus.js";
import { HeartbeatWorker } from "../lock/heartbeat-worker.js";
import type { Logger } from "../logger/index.js";
import type {
  OqronJob,
  OqronJobOptions,
  RemoveOnConfig,
} from "../types/job.types.js";
import { calculateBackoff } from "./backoffs.js";
import { DependencyResolver } from "./dependency-resolver.js";
import { pruneAfterCompletion } from "./job-retention.js";

// ── Shared configuration shape ──────────────────────────────────────────────
// Both QueueConfig and WorkerConfig expose overlapping execution settings.
// This interface captures only the fields needed by the execution loop.

export interface JobHandlerConfig {
  /** Queue/topic name used in Broker operations */
  name: string;
  /** The handler function to execute. Optional when processBatch is set. */
  handler?: (ctx: QueueJobContext<any>) => Promise<any>;
  /** Batch handler — receives an array of job contexts. Mutually exclusive with handler. */
  processBatch?: (
    jobs: QueueJobContext<any>[],
  ) => Promise<Array<PromiseSettledResult<any>> | void>;
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
    strategy?: "fixed" | "exponential" | "custom";
    baseDelay?: number;
    maxDelay?: number;
    /** F7: Custom backoff function. Only used when strategy is "custom". */
    backoffFn?: (attempt: number, baseDelay: number) => number;
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
    /** DX3: Alias for onSuccess */
    afterRun?: (job: OqronJob, result: any) => Promise<void> | void;
    /** DX3: Alias for onFail */
    onError?: (job: OqronJob, error: Error) => Promise<void> | void;
  };
  /**
   * F6: Pre-execution condition gate.
   * If condition returns false, the job is nacked with a delay.
   */
  condition?: (ctx: QueueJobContext) => Promise<boolean> | boolean;
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

type PreExecutionState = Pick<
  OqronJob,
  | "status"
  | "workerId"
  | "startedAt"
  | "processedOn"
  | "attemptMade"
  | "timeline"
>;

function capturePreExecutionState(job: OqronJob): PreExecutionState {
  return {
    status: job.status,
    workerId: job.workerId,
    startedAt: job.startedAt,
    processedOn: job.processedOn,
    attemptMade: job.attemptMade,
    timeline: job.timeline ? [...job.timeline] : undefined,
  };
}

function restorePreExecutionState(
  job: OqronJob,
  state: PreExecutionState,
): void {
  job.status = state.status;
  job.workerId = state.workerId;
  job.startedAt = state.startedAt;
  job.processedOn = state.processedOn;
  job.attemptMade = state.attemptMade;
  job.timeline = state.timeline;
}

async function nackJob(
  di: OqronContainer,
  queueName: string,
  job: Pick<OqronJob, "id" | "opts">,
  delayMs?: number,
): Promise<void> {
  if (job.opts?.priority !== undefined) {
    await di.broker.nack(queueName, job.id, delayMs, job.opts.priority);
    return;
  }
  if (delayMs !== undefined) {
    await di.broker.nack(queueName, job.id, delayMs);
    return;
  }
  await di.broker.nack(queueName, job.id);
}

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
  const baseDelay = hc.retries?.baseDelay ?? md.retries?.baseDelay ?? 2000;
  const maxDelay = hc.retries?.maxDelay ?? md.retries?.maxDelay ?? 60000;

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
      // Bug #1: Also extend broker claim lock on each heartbeat tick
      async () => {
        try {
          await di.broker.extendLock(job.id, workerId, lockTtlMs, hc.name);
        } catch {
          // Broker extendLock failure is non-fatal — ILockAdapter is authoritative
        }
      },
      // Bug #24: Abort handler when lock is lost to prevent duplicate execution
      () => {
        const ac = ctx.abortControllers.get(job.id);
        if (ac && !ac.signal.aborted) {
          logger.warn(`Lock lost for job ${job.id} — aborting handler`, {
            jobId: job.id,
            lockKey,
          });
          ac.abort();
        }
      },
    );

    const acquired = await heartbeat.start();
    if (!acquired) {
      logger.warn(`Failed to acquire heartbeat lock for job ${job.id}`);
      await nackJob(di, hc.name, job);
      return;
    }
    ctx.heartbeats.set(job.id, heartbeat);
  }

  // ── Create AbortController for cancellation support ────────────────────
  const abortController = new AbortController();
  ctx.abortControllers.set(job.id, abortController);

  // Compute max attempts for context
  const maxAttempts = effectiveMaxRetries + 1;

  // C1: Capture start time for duration getter
  const executionStartTime = Date.now();

  // C2: Build hybrid function+object log API
  const logFn = (level: "info" | "warn" | "error", msg: string) => {
    const method = logger[level] || logger.info;
    method.call(logger, `[${ctx.lockPrefix}:${hc.name}] ${msg}`, {
      jobId: job.id,
    });
    if (!job.logs) job.logs = [];
    job.logs.push({ level, msg, ts: new Date() });
    // Best effort async save for logs without blocking execution
    di.storage.save("jobs", job.id, job).catch(() => {});
  };
  // Attach object-style methods (C2)
  logFn.info = (msg: string) => logFn("info", msg);
  logFn.warn = (msg: string) => logFn("warn", msg);
  logFn.error = (msg: string) => logFn("error", msg);

  const jobCtx: QueueJobContext<any> = {
    id: job.id,
    name: hc.name,
    data: job.data,
    signal: abortController.signal,
    get aborted() {
      return abortController.signal.aborted;
    },
    environment: job.environment ?? ctx.environment,
    project: job.project ?? ctx.project,
    attempt: (job.attemptMade ?? 0) + 1,
    maxAttempts,
    createdAt: job.createdAt ? new Date(job.createdAt) : new Date(),
    // C1: Live elapsed time getter
    get duration() {
      return Date.now() - executionStartTime;
    },
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
    log: logFn,
    discard: () => {
      internalDiscarded = true;
    },
    // C3: Return current progress value from job record
    getProgress: () => job.progressPercent ?? 0,
    // v2: Dynamic child spawning
    spawnChild: async <C = any>(
      queueName: string,
      data: C,
      childOpts?: OqronJobOptions,
    ) => {
      const childId = childOpts?.jobId ?? randomUUID();
      const childJob: OqronJob<C> = {
        id: childId,
        type: "task",
        queueName,
        status: childOpts?.delay ? "delayed" : "waiting",
        moduleName: queueName,
        data,
        opts: childOpts ?? {},
        attemptMade: 0,
        progressPercent: 0,
        parentId: job.id,
        tags: [],
        environment: job.environment ?? ctx.environment,
        project: job.project ?? ctx.project,
        createdAt: new Date(),
        queuedAt: new Date(),
        triggeredBy: "flow",
      };
      // Save child job to storage
      await di.storage.save("jobs", childId, childJob);
      // Link child to parent
      if (!job.childrenIds) job.childrenIds = [];
      if (!job.childrenIds.includes(childId)) {
        job.childrenIds.push(childId);
        await di.storage.save("jobs", job.id, job);
      }
      // Publish to broker
      await di.broker.publish(
        queueName,
        childId,
        childOpts?.delay,
        childOpts?.priority,
      );
      OqronEventBus.emit("job:child:spawned", job.id, childId, queueName);
      logger.info(`Spawned child job ${childId} on queue ${queueName}`, {
        parentId: job.id,
      });
      return childId;
    },
  };

  // Update state to active
  const previousState = capturePreExecutionState(job);
  const oldStatus = previousState.status;
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
      const rlResult = await hc.rateLimiter
        .check(jobCtx)
        .catch(() => ({ allowed: true }));
      if (!rlResult.allowed) {
        logger.info(`Job ${job.id} rate-limited, nacking back to broker`);
        // Stop heartbeat before nack
        if (heartbeat) {
          await heartbeat.stop();
          ctx.heartbeats.delete(job.id);
        }
        ctx.abortControllers.delete(job.id);
        // Restore all pre-claim metadata so skipped jobs do not look attempted.
        restorePreExecutionState(job, previousState);
        await di.storage.save("jobs", job.id, job);
        await nackJob(di, hc.name, job, 1000); // Small delay before retry
        return;
      }
    }

    // ── Pre-execution: beforeRun hook ──────────────────────────────────
    if (hc.hooks?.beforeRun) {
      await hc.hooks.beforeRun(jobCtx);
    }

    // ── F6: Pre-execution condition gate ─────────────────────────────────
    if (hc.condition) {
      const allowed = await Promise.resolve(hc.condition(jobCtx)).catch(
        () => true,
      );
      if (!allowed) {
        logger.info(
          `Job ${job.id} condition gate returned false, nacking back to broker`,
        );
        // Stop heartbeat before nack
        if (heartbeat) {
          await heartbeat.stop();
          ctx.heartbeats.delete(job.id);
        }
        ctx.abortControllers.delete(job.id);
        // Restore all pre-claim metadata so skipped jobs do not look attempted.
        restorePreExecutionState(job, previousState);
        await di.storage.save("jobs", job.id, job);
        await nackJob(di, hc.name, job, 2000); // Re-queue with 2s delay
        return;
      }
    }

    let timeoutHandle: any;
    const activeHandler = hc.handler!;
    const executePromise = activeHandler(jobCtx);

    try {
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
    } finally {
      // E1: Always clear timeout — even if handler throws — to prevent timer leak
      if (timeoutHandle) clearTimeout(timeoutHandle);
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
        // F7: Pass through custom backoff function if strategy is "custom"
        backoffFn: hc.retries?.backoffFn,
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

      // Stop heartbeat before nack
      if (heartbeat) {
        await heartbeat.stop();
        ctx.heartbeats.delete(job.id);
      }

      // Clean up abort controller
      ctx.abortControllers.delete(job.id);

      OqronEventBus.emit(
        "job:retried",
        job.id,
        `attempt:${job.attemptMade + 1}`,
      );
      await di.storage.save("jobs", job.id, job);
      await nackJob(di, hc.name, job, delay);
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

  // ── E2: Cancellation finality — re-read from storage if aborted ─────
  if (abortController.signal.aborted) {
    const fresh = await di.storage.get<OqronJob>("jobs", job.id);
    if (fresh?.status === "cancelled") {
      // Manager wrote "cancelled" during execution — respect it
      logger.info(
        `Job ${job.id} was cancelled by manager — honouring cancellation`,
      );
      return;
    }
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
    job.latencyMs =
      new Date(job.startedAt).getTime() - new Date(job.queuedAt).getTime();
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
    await DependencyResolver.notifyChildren(di.storage, di.broker, job.id);
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
    // DX3: afterRun alias
    if (hc.hooks?.afterRun) {
      void Promise.resolve()
        .then(() => hc.hooks!.afterRun!(job as OqronJob, result))
        .catch((e) => logger.error("afterRun hook failed", { err: String(e) }));
    }
  } else {
    const errorObject = new Error(error ?? "Unknown error");
    OqronEventBus.emit("job:fail", job.queueName, job.id, errorObject);

    if (hc.hooks?.onFail) {
      void Promise.resolve()
        .then(() => hc.hooks!.onFail!(job as OqronJob, errorObject))
        .catch((e) => logger.error("onFail hook failed", { err: String(e) }));
    }
    // DX3: onError alias
    if (hc.hooks?.onError) {
      void Promise.resolve()
        .then(() => hc.hooks!.onError!(job as OqronJob, errorObject))
        .catch((e) => logger.error("onError hook failed", { err: String(e) }));
    }

    // DLQ: invoke dead letter hook if enabled and retries exhausted
    const dlqEnabled = hc.deadLetter?.enabled ?? md.deadLetter?.enabled;
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
    job.timeline = job.timeline.slice(
      job.timeline.length - MAX_TIMELINE_ENTRIES,
    );
  }
}

// ── v2: Batch Execution ──────────────────────────────────────────────────────

/**
 * Shared context builder — extracted for reuse in both single and batch execution.
 * Returns the built QueueJobContext without executing the handler.
 */
function buildJobContext(
  job: OqronJob,
  ctx: JobExecutionContext,
): {
  jobCtx: QueueJobContext;
  abortController: AbortController;
  getDiscarded: () => boolean;
} {
  const { di, logger, handlerConfig: hc } = ctx;

  const abortController = new AbortController();
  ctx.abortControllers.set(job.id, abortController);

  const maxRetries = hc.retries?.max ?? ctx.moduleDefaults.retries?.max ?? 0;
  const effectiveMaxRetries = job.opts?.attempts
    ? job.opts.attempts - 1
    : maxRetries;
  const maxAttempts = effectiveMaxRetries + 1;
  const executionStartTime = Date.now();

  // C2: Build hybrid function+object log API
  const logFn = (level: "info" | "warn" | "error", msg: string) => {
    const method = logger[level] || logger.info;
    method.call(logger, `[batch:${hc.name}] ${msg}`, { jobId: job.id });
    if (!job.logs) job.logs = [];
    job.logs.push({ level, msg, ts: new Date() });
    di.storage.save("jobs", job.id, job).catch(() => {});
  };
  logFn.info = (msg: string) => logFn("info", msg);
  logFn.warn = (msg: string) => logFn("warn", msg);
  logFn.error = (msg: string) => logFn("error", msg);

  let internalDiscarded = false;

  const jobCtx: QueueJobContext<any> = {
    id: job.id,
    name: hc.name,
    data: job.data,
    signal: abortController.signal,
    get aborted() {
      return abortController.signal.aborted;
    },
    environment: job.environment ?? ctx.environment,
    project: job.project ?? ctx.project,
    attempt: (job.attemptMade ?? 0) + 1,
    maxAttempts,
    createdAt: job.createdAt ? new Date(job.createdAt) : new Date(),
    get duration() {
      return Date.now() - executionStartTime;
    },
    progress: async (percent, label) => {
      job.progressPercent = percent;
      job.progressLabel = label;
      await di.storage.save("jobs", job.id, job);
      OqronEventBus.emit("job:progress", job.queueName, job.id, percent);
    },
    log: logFn,
    discard: () => {
      internalDiscarded = true;
    },
    getProgress: () => job.progressPercent ?? 0,
    spawnChild: async <C = any>(
      queueName: string,
      data: C,
      childOpts?: OqronJobOptions,
    ) => {
      const childId = childOpts?.jobId ?? randomUUID();
      const childJob: OqronJob<C> = {
        id: childId,
        type: "task",
        queueName,
        status: childOpts?.delay ? "delayed" : "waiting",
        moduleName: queueName,
        data,
        opts: childOpts ?? {},
        attemptMade: 0,
        progressPercent: 0,
        parentId: job.id,
        tags: [],
        environment: job.environment ?? ctx.environment,
        project: job.project ?? ctx.project,
        createdAt: new Date(),
        queuedAt: new Date(),
        triggeredBy: "flow",
      };
      await di.storage.save("jobs", childId, childJob);
      if (!job.childrenIds) job.childrenIds = [];
      if (!job.childrenIds.includes(childId)) {
        job.childrenIds.push(childId);
        await di.storage.save("jobs", job.id, job);
      }
      await di.broker.publish(
        queueName,
        childId,
        childOpts?.delay,
        childOpts?.priority,
      );
      return childId;
    },
  };

  return { jobCtx, abortController, getDiscarded: () => internalDiscarded };
}

/**
 * Execute a batch of jobs using `processBatch`.
 * Supports Partial Responses: jobs can individually succeed, fail, or be discarded.
 * Falls back to all-or-nothing failure if the handler throws synchronously.
 */
export async function executeBatch(
  jobs: OqronJob[],
  ctx: JobExecutionContext,
): Promise<void> {
  if (jobs.length === 0) return;
  const { di, logger, workerId, handlerConfig: hc, moduleDefaults: md } = ctx;

  if (!hc.processBatch) {
    // Fallback: execute individually in parallel
    await Promise.all(jobs.map((job) => executeJob(job, ctx)));
    return;
  }

  const lockTtlMs = hc.lockTtlMs ?? md.lockTtlMs ?? 30000;
  const heartbeatMs = hc.heartbeatMs ?? md.heartbeatMs ?? 5000;
  const useGuaranteed = hc.guaranteedWorker !== false;

  // Resolve retry config
  const maxRetries = hc.retries?.max ?? md.retries?.max ?? 0;
  const retryStrategy =
    hc.retries?.strategy ?? md.retries?.strategy ?? "exponential";
  const baseDelay = hc.retries?.baseDelay ?? md.retries?.baseDelay ?? 2000;
  const maxDelay = hc.retries?.maxDelay ?? md.retries?.maxDelay ?? 60000;

  // ── Heartbeat: one lock for the entire batch ──────────────────────────
  const batchId = jobs[0].id; // Use first job ID as batch lock key
  let heartbeat: HeartbeatWorker | null = null;
  // Bug #24: Collect batch abort controllers so onLockLost can abort them all
  const batchAbortControllers: AbortController[] = [];
  if (useGuaranteed) {
    const lockKey = `${ctx.lockPrefix}:batch:${batchId}`;
    heartbeat = new HeartbeatWorker(
      di.lock,
      logger,
      lockKey,
      workerId,
      lockTtlMs,
      heartbeatMs,
      // Bug #1: Also extend broker claim locks for all jobs in batch
      async () => {
        for (const job of jobs) {
          try {
            await di.broker.extendLock(job.id, workerId, lockTtlMs, hc.name);
          } catch {
            // Non-fatal — ILockAdapter is authoritative
          }
        }
      },
      // Bug #24: Abort all batch handlers when batch lock is lost
      () => {
        logger.warn(
          `Batch lock lost for ${batchId} — aborting all batch handlers`,
          {
            batchId,
            lockKey,
            jobCount: batchAbortControllers.length,
          },
        );
        for (const ac of batchAbortControllers) {
          if (!ac.signal.aborted) ac.abort();
        }
      },
    );
    const acquired = await heartbeat.start();
    if (!acquired) {
      logger.warn(
        `Failed to acquire batch heartbeat lock for batch starting with ${batchId}`,
      );
      for (const job of jobs) {
        await nackJob(di, hc.name, job);
      }
      return;
    }
  }

  // ── Build contexts for all jobs ────────────────────────────────────────
  type BatchExecutionEntry = {
    job: OqronJob;
    jobCtx: QueueJobContext;
    abortController: AbortController;
    getDiscarded: () => boolean;
    preflightResult?: PromiseSettledResult<any>;
  };

  const readyContexts: BatchExecutionEntry[] = [];
  const preflightFailures: BatchExecutionEntry[] = [];
  for (const job of jobs) {
    job.moduleName = job.moduleName ?? hc.name;
    const previousState = capturePreExecutionState(job);
    const { jobCtx, abortController, getDiscarded } = buildJobContext(job, ctx);
    // Bug #24: Track batch abort controllers for lock-lost abort
    batchAbortControllers.push(abortController);

    const oldStatus = previousState.status;
    job.status = "active";
    job.startedAt = new Date();
    job.attemptMade = (job.attemptMade ?? 0) + 1;
    job.workerId = workerId;
    job.processedOn = job.startedAt;
    if (!job.timeline) job.timeline = [];
    pushTimeline(job, {
      ts: job.startedAt,
      from: oldStatus,
      to: "active",
      reason: `Worker ${workerId} claimed job`,
    });
    await di.storage.save("jobs", job.id, job);
    OqronEventBus.emit("job:start", job.queueName, job.id, hc.name);

    if (hc.rateLimiter) {
      const rlResult = await hc.rateLimiter
        .check(jobCtx)
        .catch(() => ({ allowed: true }));
      if (!rlResult.allowed) {
        logger.info(`Batch job ${job.id} rate-limited, nacking back to broker`);
        ctx.abortControllers.delete(job.id);
        restorePreExecutionState(job, previousState);
        await di.storage.save("jobs", job.id, job);
        await nackJob(di, hc.name, job, 1000);
        continue;
      }
    }

    if (hc.hooks?.beforeRun) {
      try {
        await hc.hooks.beforeRun(jobCtx);
      } catch (e: any) {
        const reason =
          e instanceof Error
            ? e
            : new Error(e?.message ?? "beforeRun hook failed");
        preflightFailures.push({
          job,
          jobCtx,
          abortController,
          getDiscarded,
          preflightResult: { status: "rejected", reason },
        });
        continue;
      }
    }

    if (hc.condition) {
      const allowed = await Promise.resolve(hc.condition(jobCtx)).catch(
        () => true,
      );
      if (!allowed) {
        logger.info(
          `Batch job ${job.id} condition gate returned false, nacking back to broker`,
        );
        ctx.abortControllers.delete(job.id);
        restorePreExecutionState(job, previousState);
        await di.storage.save("jobs", job.id, job);
        await nackJob(di, hc.name, job, 2000);
        continue;
      }
    }

    readyContexts.push({ job, jobCtx, abortController, getDiscarded });
  }

  const allContexts = [...preflightFailures, ...readyContexts];
  if (allContexts.length === 0) {
    if (heartbeat) {
      await heartbeat.stop();
    }
    return;
  }

  let results: Array<PromiseSettledResult<any>> | void | undefined;
  let topLevelError: Error | undefined;
  let batchCompleted = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  try {
    if (readyContexts.length > 0) {
      const processPromise = hc.processBatch(
        readyContexts.map((c) => c.jobCtx),
      );

      if (typeof hc.timeout === "number") {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            for (const { abortController } of readyContexts) {
              abortController.abort();
            }
            const err = new Error(`Batch exceeded timeout of ${hc.timeout}ms`);
            err.name = "TimeoutError";
            reject(err);
          }, hc.timeout);
        });
        results = await Promise.race([processPromise, timeoutPromise]);
      } else {
        results = await processPromise;
      }
    } else {
      results = [];
    }
    batchCompleted = true;
  } catch (e: any) {
    topLevelError =
      e instanceof Error
        ? e
        : new Error(e?.message ?? "Batch processing failed");
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  // ── Stop Heartbeat & Cleanup Controllers ──────────────────────────────
  if (heartbeat) {
    await heartbeat.stop();
  }
  for (const { job } of allContexts) {
    ctx.abortControllers.delete(job.id);
  }

  // ── Finalize Jobs ─────────────────────────────────────────────────────
  const finishedAt = new Date();

  // If top-level error occurred, synthesize rejected results for processBatch jobs.
  const processResults: Array<PromiseSettledResult<any>> = topLevelError
    ? readyContexts.map(() => ({ status: "rejected", reason: topLevelError }))
    : Array.isArray(results)
      ? results
      : batchCompleted
        ? readyContexts.map(() => ({ status: "fulfilled", value: undefined }))
        : readyContexts.map(() => ({
            status: "rejected",
            reason: new Error("Batch processing failed"),
          }));

  const resolvedResults: Array<PromiseSettledResult<any>> = [
    ...preflightFailures.map((entry) => entry.preflightResult!),
    ...processResults,
  ];

  for (let i = 0; i < allContexts.length; i++) {
    const { job, getDiscarded } = allContexts[i];
    // In case the returned array is shorter than contexts array, assume rejected with out-of-bounds error
    const result = resolvedResults[i] ?? {
      status: "rejected",
      reason: new Error("processBatch returned fewer results than jobs"),
    };

    let finalStatus: "completed" | "failed" = "completed";
    let finalError: string | undefined;

    const isDiscarded = getDiscarded();

    if (isDiscarded) {
      // Discarded jobs silently "complete" but are really just acked and dropped.
      finalStatus = "completed";
      job.progressLabel = "Discarded";
      job.error = "Job discarded via ctx.discard()";
      // Ensure we don't retry it
      job.attemptMade = maxRetries + 1;
    } else if (result.status === "fulfilled") {
      finalStatus = "completed";
      job.returnValue = result.value;
      job.progressPercent = 100;
      job.progressLabel = "Completed";
    } else {
      finalStatus = "failed";
      finalError =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
      job.error = finalError;

      const effectiveMax = job.opts?.attempts
        ? job.opts.attempts - 1
        : maxRetries;
      const shouldRetry = job.attemptMade <= effectiveMax;

      if (shouldRetry) {
        // Will retry
        const backoffOpts = { type: retryStrategy, delay: baseDelay };
        const delay = calculateBackoff(backoffOpts, job.attemptMade, maxDelay);
        job.status = "delayed";

        OqronEventBus.emit(
          "job:retried",
          job.id,
          `attempt:${job.attemptMade + 1}`,
        );
        await di.storage.save("jobs", job.id, job);
        await nackJob(di, hc.name, job, delay);
        continue; // Skip the standard completion save/ack below
      }
    }

    // Completion or permanent failure path
    job.status = finalStatus;
    job.finishedAt = finishedAt;
    if (job.startedAt) {
      job.durationMs = finishedAt.getTime() - new Date(job.startedAt).getTime();
    }

    if (!job.timeline) job.timeline = [];
    pushTimeline(job, {
      ts: finishedAt,
      from: "active",
      to: finalStatus,
      reason: isDiscarded
        ? "Discarded"
        : finalStatus === "failed"
          ? finalError
          : "Batch completed",
    });

    await di.storage.save("jobs", job.id, job);
    await di.broker.ack(hc.name, job.id);

    if (job.childrenIds?.length) {
      await DependencyResolver.notifyChildren(di.storage, di.broker, job.id);
    }

    // ── Events & Hooks ──────────────────────────────────────────────
    if (finalStatus === "completed" && !isDiscarded) {
      OqronEventBus.emit("job:success", job.queueName, job.id);
      if (hc.hooks?.onSuccess) {
        try {
          await hc.hooks.onSuccess(job as any, job.returnValue);
        } catch (e) {
          logger.error(`Hooks.onSuccess failed: ${e}`);
        }
      }
      if (hc.hooks?.afterRun) {
        try {
          await hc.hooks.afterRun(job as any, job.returnValue);
        } catch (e) {
          logger.error(`Hooks.afterRun failed: ${e}`);
        }
      }
    } else if (finalStatus === "failed") {
      const errObj = new Error(finalError ?? "Unknown error");
      OqronEventBus.emit("job:fail", job.queueName, job.id, errObj);
      if (hc.hooks?.onFail) {
        try {
          await hc.hooks.onFail(job as any, errObj);
        } catch (e) {
          logger.error(`Hooks.onFail failed: ${e}`);
        }
      }
      if (hc.hooks?.onError) {
        try {
          await hc.hooks.onError(job as any, errObj);
        } catch (e) {
          logger.error(`Hooks.onError failed: ${e}`);
        }
      }
    }

    // ── Job Retention / Pruning ─────────────────────────────────────
    await pruneAfterCompletion({
      namespace: "jobs",
      jobId: job.id,
      status: finalStatus,
      jobRemoveConfig:
        finalStatus === "completed"
          ? job.opts?.removeOnComplete
          : job.opts?.removeOnFail,
      moduleRemoveConfig:
        finalStatus === "completed" ? hc.removeOnComplete : hc.removeOnFail,
      globalRemoveConfig:
        finalStatus === "completed" ? md.removeOnComplete : md.removeOnFail,
      filterKey: "queueName",
      filterValue: hc.name,
    });
  }
}
