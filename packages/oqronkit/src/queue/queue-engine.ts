import { randomUUID } from "node:crypto";
import type { IOqronModule, Logger } from "../engine/index.js";
import { OqronContainer, OqronEventBus } from "../engine/index.js";
import { HeartbeatWorker } from "../engine/lock/heartbeat-worker.js";
import { StallDetector } from "../engine/lock/stall-detector.js";
import type { OqronConfig } from "../engine/types/config.types.js";
import type { BrokerStrategy } from "../engine/types/engine.js";
import type { OqronJob } from "../engine/types/job.types.js";
import { calculateBackoff } from "../engine/utils/backoffs.js";
import { DependencyResolver } from "../engine/utils/dependency-resolver.js";
import { pruneAfterCompletion } from "../engine/utils/job-retention.js";
import type { QueueModuleDef } from "../modules.js";
import { getRegisteredQueues } from "./registry.js";
import type { QueueConfig, QueueJobContext } from "./types.js";

export class QueueEngine implements IOqronModule {
  public readonly name = "queue";
  public enabled = true;
  private running = false;
  private timers: NodeJS.Timeout[] = [];
  private workerIdStr = randomUUID();
  /** All active job promises — used for drain during shutdown */
  private activeJobs = new Map<string, Promise<void>>();
  /** Per-queue active job tracking — ensures concurrency is isolated per queue */
  private activeJobsByQueue = new Map<string, Set<string>>();
  /** Active heartbeat workers keyed by job ID — for crash-safe lock renewal */
  private heartbeats = new Map<string, HeartbeatWorker>();
  /** AbortControllers keyed by job ID — for mid-execution cancellation */
  private abortControllers = new Map<string, AbortController>();
  /** Stall detector — reclaims jobs whose heartbeat locks have expired */
  private stallDetector: StallDetector | null = null;

  constructor(
    private config: OqronConfig,
    private logger: Logger,
    private queueConfig?: QueueModuleDef,
    private container?: OqronContainer,
  ) {}

  private get di(): OqronContainer {
    return this.container ?? OqronContainer.get();
  }

  async init(): Promise<void> {
    const qs = getRegisteredQueues();
    this.logger.info(`Initialized QueueEngine covering ${qs.length} endpoints`);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const qs = getRegisteredQueues();
    for (const q of qs) {
      this.startPolling(q);
    }

    // Start stall detector — checks for jobs whose heartbeat locks have expired
    const stalledInterval = this.queueConfig?.stalledInterval ?? 30000;

    this.stallDetector = new StallDetector(
      this.di.lock,
      this.logger,
      stalledInterval,
    );
    this.stallDetector.start(
      () =>
        Array.from(this.heartbeats.entries()).map(([jobId, _hb]) => ({
          key: `queue:job:${jobId}`,
          ownerId: this.workerIdStr,
        })),
      (key: string) => {
        // Extract jobId from lock key
        const jobId = key.replace("queue:job:", "");
        this.logger.warn(
          `Stall detected for Queue job ${jobId} — nacking back to broker`,
        );
        this.heartbeats.get(jobId)?.stop();
        this.heartbeats.delete(jobId);
        // Find the queue name for nack
        const queueName = qs.find((_q) => this.activeJobs.has(jobId))?.name;
        if (queueName) {
          // Increment stalledCount and update telemetry before returning to broker
          this.di.storage.get<any>("jobs", jobId).then(async job => {
            if (job) {
              job.stalledCount = (job.stalledCount ?? 0) + 1;
              if (!job.timeline) job.timeline = [];
              job.timeline.push({
                ts: new Date(),
                from: job.status,
                to: "stalled",
                reason: `Worker lock expired. Re-enqueuing.`
              });
              job.status = "stalled";
              try {
                await this.di.storage.save("jobs", jobId, job);
              } catch (e) {
                this.logger.error("Failed to commit stall telemetry", { jobId, error: String(e) });
              }
            }
          }).finally(() => {
            void this.di.broker.nack(queueName, jobId);
          });
        }
      },
    );
  }

  async triggerManual(id: string): Promise<boolean> {
    const q = getRegisteredQueues().find((q) => q.name === id);
    if (q) {
      await this.poll(q);
      return true;
    }
    return false;
  }

  async enable(): Promise<void> {
    this.enabled = true;
    if (!this.running) {
      await this.start();
    }
  }

  async disable(): Promise<void> {
    this.enabled = false;
  }

  /**
   * Cancel an actively running job via AbortController.
   * Aborts the handler, stops the heartbeat, and marks the job as failed.
   */
  async cancelActiveJob(jobId: string): Promise<boolean> {
    const controller = this.abortControllers.get(jobId);
    if (!controller) return false;

    controller.abort();
    this.abortControllers.delete(jobId);

    // Stop heartbeat
    const hb = this.heartbeats.get(jobId);
    if (hb) {
      await hb.stop();
      this.heartbeats.delete(jobId);
    }

    // Mark job as failed/cancelled in storage
    const job = await this.di.storage.get<OqronJob>("jobs", jobId);
    if (job) {
      job.status = "failed";
      job.error = "Cancelled";
      job.finishedAt = new Date();
      await this.di.storage.save("jobs", jobId, job);

      // Ack from broker so it's not re-processed
      await this.di.broker.ack(job.queueName, jobId);
      OqronEventBus.emit(
        "job:fail",
        job.queueName,
        jobId,
        new Error("Cancelled"),
      );
    }

    return true;
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];

    // Stop stall detector
    this.stallDetector?.stop();
    this.stallDetector = null;

    // Abort all active jobs
    for (const controller of this.abortControllers.values()) {
      controller.abort();
    }
    this.abortControllers.clear();

    // Stop all active heartbeats
    for (const hb of this.heartbeats.values()) {
      await hb.stop();
    }
    this.heartbeats.clear();

    const allActive = Array.from(this.activeJobs.values());
    if (allActive.length > 0) {
      this.logger.info(
        `QueueEngine draining ${allActive.length} active jobs...`,
      );
      const timeout = this.queueConfig?.shutdownTimeout ?? 25000;
      await Promise.race([
        Promise.allSettled(allActive),
        new Promise((r) => {
          const h = setTimeout(r, timeout);
          h.unref();
        }),
      ]);
    }
  }

  private startPolling(q: QueueConfig) {
    const heartbeatMs = q.heartbeatMs ?? this.queueConfig?.heartbeatMs ?? 5000;
    const t = setInterval(() => {
      this.poll(q).catch((e) =>
        this.logger.error(`Queue poller crashed for ${q.name}`, e),
      );
    }, heartbeatMs);
    t.unref();
    this.timers.push(t);
    setTimeout(() => this.poll(q), 0);
  }

  private async poll(q: QueueConfig): Promise<void> {
    if (!this.running || !this.enabled) return;

    const concurrency = q.concurrency ?? this.queueConfig?.concurrency ?? 5;
    const lockTtlMs = q.lockTtlMs ?? this.queueConfig?.lockTtlMs ?? 30000;

    // Per-queue concurrency: count only active jobs for THIS queue, not all queues
    const activeForQueue = this.activeJobsByQueue.get(q.name)?.size ?? 0;
    const freeSlots = concurrency - activeForQueue;
    if (freeSlots <= 0) return;

    // 1. Claim IDs from Broker with ordering strategy
    const strategy: BrokerStrategy =
      q.strategy ?? this.queueConfig?.strategy ?? "fifo";
    const jobIds = await this.di.broker.claim(
      q.name,
      this.workerIdStr,
      freeSlots,
      lockTtlMs,
      strategy,
    );

    for (const id of jobIds) {
      // 2. Fetch full payload from Storage
      const job = await this.di.storage.get<OqronJob>("jobs", id);
      if (!job) {
        this.logger.error(`Claimed job ${id} not found in Storage!`, { id });
        await this.di.broker.ack(q.name, id);
        continue;
      }

      // Environment isolation: nack jobs from different environments
      if (
        job.environment &&
        this.config.environment &&
        job.environment !== this.config.environment
      ) {
        this.logger.warn(`Returning job ${id} — wrong environment`, {
          jobEnv: job.environment,
          workerEnv: this.config.environment,
        });
        await this.di.broker.nack(q.name, id);
        continue;
      }

      // Track in per-queue active set
      if (!this.activeJobsByQueue.has(q.name)) {
        this.activeJobsByQueue.set(q.name, new Set());
      }
      this.activeJobsByQueue.get(q.name)!.add(id);

      const p = this.executeJob(job, q).finally(() => {
        this.activeJobs.delete(id);
        this.activeJobsByQueue.get(q.name)?.delete(id);
      });
      this.activeJobs.set(id, p);
    }
  }

  private async executeJob(job: OqronJob, q: QueueConfig): Promise<void> {
    let internalDiscarded = false;
    const lockTtlMs = q.lockTtlMs ?? this.queueConfig?.lockTtlMs ?? 30000;
    const heartbeatMs = q.heartbeatMs ?? this.queueConfig?.heartbeatMs ?? 5000;
    const useGuaranteed = q.guaranteedWorker !== false;

    // Resolve retry config: per-queue → global → default
    const maxRetries = q.retries?.max ?? this.queueConfig?.retries?.max ?? 0;
    const retryStrategy =
      q.retries?.strategy ??
      this.queueConfig?.retries?.strategy ??
      "exponential";
    const baseDelay =
      q.retries?.baseDelay ?? this.queueConfig?.retries?.baseDelay ?? 2000;
    const maxDelay =
      q.retries?.maxDelay ?? this.queueConfig?.retries?.maxDelay ?? 60000;

    // Per-job attempts override takes highest priority
    const effectiveMaxRetries = job.opts?.attempts
      ? job.opts.attempts - 1
      : maxRetries;

    // ── Start HeartbeatWorker for crash-safe lock renewal ─────────────────
    let heartbeat: HeartbeatWorker | null = null;
    if (useGuaranteed) {
      const lockKey = `queue:job:${job.id}`;
      heartbeat = new HeartbeatWorker(
        this.di.lock,
        this.logger,
        lockKey,
        this.workerIdStr,
        lockTtlMs,
        heartbeatMs,
      );
      const acquired = await heartbeat.start();
      if (!acquired) {
        this.logger.warn(`Failed to acquire heartbeat lock for job ${job.id}`);
        // Another worker may have claimed this — nack back to broker
        await this.di.broker.nack(q.name, job.id);
        return;
      }
      this.heartbeats.set(job.id, heartbeat);
    }

    // ── Create AbortController for cancellation support ────────────────────
    const abortController = new AbortController();
    this.abortControllers.set(job.id, abortController);

    const ctx: QueueJobContext<any> = {
      id: job.id,
      data: job.data,
      signal: abortController.signal,
      queueName: job.queueName,
      moduleName: job.moduleName ?? q.name,
      environment: job.environment ?? this.config.environment ?? "default",
      project: job.project ?? this.config.project ?? "default",
      progress: async (percent, label) => {
        job.progressPercent = percent;
        job.progressLabel = label;
        if (!job.timeline) job.timeline = [];
        job.timeline.push({
          ts: new Date(),
          from: "active",
          to: "active",
          reason: `Progress: ${percent}% ${label || ""}`,
        });
        await this.di.storage.save("jobs", job.id, job);
        OqronEventBus.emit("job:progress", job.queueName, job.id, percent);
      },
      log: (level, msg) => {
        const method = this.logger[level] || this.logger.info;
        method.call(this.logger, `[Queue:${q.name}] ${msg}`, {
          jobId: job.id,
        });
        if (!job.logs) job.logs = [];
        job.logs.push({ level, msg, ts: new Date() });
        // Best effort async save for logs without blocking execution
        this.di.storage.save("jobs", job.id, job).catch(() => {});
      },
      discard: () => {
        internalDiscarded = true;
      },
    };

    // Update state to active
    const oldStatus = job.status;
    job.status = "active";
    job.workerId = this.workerIdStr;
    job.startedAt = new Date();
    job.processedOn = new Date();
    job.attemptMade = (job.attemptMade ?? 0) + 1;
    if (!job.timeline) job.timeline = [];
    job.timeline.push({
      ts: job.startedAt,
      from: oldStatus,
      to: "active",
      reason: `Worker ${this.workerIdStr} claimed job`,
    });
    await this.di.storage.save("jobs", job.id, job);

    OqronEventBus.emit("job:start", job.queueName, job.id, q.name);

    let status: "completed" | "failed" = "completed";
    let error: string | undefined;
    let result: any;

    try {
      let timeoutHandle: any;
      const executePromise = q.handler(ctx);

      if (typeof q.timeout === "number") {
        const timeoutPromise = new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => {
            abortController.abort(); // Signal cancellation to the handler
            const err = new Error(`Job exceeded timeout of ${q.timeout}ms`);
            err.name = "TimeoutError";
            reject(err);
          }, q.timeout);
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
        this.logger.info(`Queue job ${job.id} was cancelled`);
      }
      // Check if we should retry via nack (broker-level, crash-safe)
      else if (!internalDiscarded && job.attemptMade <= effectiveMaxRetries) {
        const backoffOpts = job.opts?.backoff ?? {
          type: retryStrategy,
          delay: baseDelay,
        };
        const delay = calculateBackoff(backoffOpts, job.attemptMade, maxDelay);

        this.logger.warn("Queue job failed, re-queuing for retry...", {
          name: q.name,
          jobId: job.id,
          attempt: job.attemptMade,
          nextIn: `${delay}ms`,
          error,
        });

        // Mark as delayed in storage so dashboards see the correct state
        job.status = "delayed";
        job.error = error;
        await this.di.storage.save("jobs", job.id, job);

        // Stop heartbeat before nack
        if (heartbeat) {
          await heartbeat.stop();
          this.heartbeats.delete(job.id);
        }

        // Clean up abort controller
        this.abortControllers.delete(job.id);

        // Nack back to broker with delay — crash-safe: if this process dies,
        // the job is already back in the broker's delayed set
        await this.di.broker.nack(q.name, job.id, delay);
        return; // Exit — the job will be re-claimed on the next poll cycle
      }

      // All retries exhausted
      this.logger.error("Queue job failed permanently", {
        name: q.name,
        jobId: job.id,
        attempts: job.attemptMade,
        error,
      });
    }

    // ── Clean up abort controller ────────────────────────────────────────
    this.abortControllers.delete(job.id);

    // ── Stop heartbeat ──────────────────────────────────────────────────
    if (heartbeat) {
      await heartbeat.stop();
      this.heartbeats.delete(job.id);
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

    if (!job.timeline) job.timeline = [];
    job.timeline.push({
      ts: finishedAt,
      from: "active",
      to: status,
      reason: status === "failed" ? error : "Finished successfully",
    });

    await this.di.storage.save("jobs", job.id, job);
    await this.di.broker.ack(q.name, job.id);

    // ── Notify dependent children ────────────────────────────────────
    if (job.childrenIds?.length) {
      await DependencyResolver.notifyChildren(
        this.di.storage,
        this.di.broker,
        job.id,
      );
    }

    // ── EventBus emissions ──────────────────────────────────────────────
    if (status === "completed") {
      OqronEventBus.emit("job:success", job.queueName, job.id);

      if (q.hooks?.onSuccess) {
        void Promise.resolve()
          .then(() => q.hooks!.onSuccess!(job as OqronJob, result))
          .catch((e) =>
            this.logger.error("onSuccess hook failed", { err: String(e) }),
          );
      }
    } else {
      const errorObject = new Error(error ?? "Unknown error");
      OqronEventBus.emit("job:fail", job.queueName, job.id, errorObject);

      if (q.hooks?.onFail) {
        void Promise.resolve()
          .then(() => q.hooks!.onFail!(job as OqronJob, errorObject))
          .catch((e) =>
            this.logger.error("onFail hook failed", { err: String(e) }),
          );
      }

      // DLQ: invoke dead letter hook if enabled and retries exhausted
      const dlqEnabled =
        q.deadLetter?.enabled ?? this.queueConfig?.deadLetter?.enabled;
      if (dlqEnabled && q.deadLetter?.onDead) {
        void Promise.resolve().then(() =>
          q.deadLetter!.onDead!(job as OqronJob).catch((e) =>
            this.logger.error("DLQ handler failed", { err: String(e) }),
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
        status === "completed" ? q.removeOnComplete : q.removeOnFail,
      globalRemoveConfig:
        status === "completed"
          ? this.queueConfig?.removeOnComplete
          : this.queueConfig?.removeOnFail,
      filterKey: "queueName",
      filterValue: q.name,
    });
  }
}
