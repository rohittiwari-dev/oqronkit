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
import { getRegisteredTaskQueues } from "./registry.js";
import type { TaskJobContext, TaskQueueConfig } from "./types.js";

export class TaskQueueEngine implements IOqronModule {
  public readonly name = "taskQueue";
  public readonly enabled = true;
  private running = false;
  private timers: NodeJS.Timeout[] = [];
  private workerIdStr = randomUUID();
  private activeJobs = new Map<string, Promise<void>>();
  /** Active heartbeat workers keyed by job ID — for crash-safe lock renewal */
  private heartbeats = new Map<string, HeartbeatWorker>();
  /** AbortControllers keyed by job ID — for mid-execution cancellation */
  private abortControllers = new Map<string, AbortController>();
  /** Stall detector — reclaims jobs whose heartbeat locks have expired */
  private stallDetector: StallDetector | null = null;

  constructor(
    private config: OqronConfig,
    private logger: Logger,
    private container?: OqronContainer,
  ) {}

  private get di(): OqronContainer {
    return this.container ?? OqronContainer.get();
  }

  async init(): Promise<void> {
    const modules = this.config.modules || [];
    if (!modules.includes("taskQueue")) return;

    const qs = getRegisteredTaskQueues();
    this.logger.info(
      `Initialized monolithic TaskQueue engine covering ${qs.length} endpoints`,
    );
  }

  async start(): Promise<void> {
    const modules = this.config.modules || [];
    if (!modules.includes("taskQueue")) return;

    if (this.running) return;
    this.running = true;

    const qs = getRegisteredTaskQueues();
    for (const q of qs) {
      this.startPolling(q);
    }

    // Start stall detector — checks for jobs whose heartbeat locks have expired
    const stalledInterval = this.config.taskQueue?.stalledInterval ?? 30000;

    this.stallDetector = new StallDetector(
      this.di.lock,
      this.logger,
      stalledInterval,
    );
    this.stallDetector.start(
      () =>
        Array.from(this.heartbeats.entries()).map(([jobId, _hb]) => ({
          key: `taskqueue:job:${jobId}`,
          ownerId: this.workerIdStr,
        })),
      (key: string) => {
        // Extract jobId from lock key
        const jobId = key.replace("taskqueue:job:", "");
        this.logger.warn(
          `Stall detected for TaskQueue job ${jobId} — nacking back to broker`,
        );
        this.heartbeats.get(jobId)?.stop();
        this.heartbeats.delete(jobId);
        // Find the queue name for nack
        const queueName = qs.find((_q) => this.activeJobs.has(jobId))?.name;
        if (queueName) {
          void this.di.broker.nack(queueName, jobId);
        }
      },
    );
  }

  async triggerManual(id: string): Promise<boolean> {
    const q = getRegisteredTaskQueues().find((q) => q.name === id);
    if (q) {
      await this.poll(q);
      return true;
    }
    return false;
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
        `TaskQueueEngine draining ${allActive.length} active jobs...`,
      );
      const timeout = this.config.taskQueue?.shutdownTimeout ?? 25000;
      await Promise.race([
        Promise.allSettled(allActive),
        new Promise((r) => setTimeout(r, timeout)),
      ]);
    }
  }

  private startPolling(q: TaskQueueConfig) {
    const heartbeatMs =
      q.heartbeatMs ?? this.config.taskQueue?.heartbeatMs ?? 5000;
    const t = setInterval(() => {
      this.poll(q).catch((e) =>
        this.logger.error(`TaskQueue poller crashed for ${q.name}`, e),
      );
    }, heartbeatMs);
    this.timers.push(t);
    setTimeout(() => this.poll(q), 0);
  }

  private async poll(q: TaskQueueConfig): Promise<void> {
    if (!this.running) return;

    const concurrency =
      q.concurrency ?? this.config.taskQueue?.concurrency ?? 5;
    const lockTtlMs = q.lockTtlMs ?? this.config.taskQueue?.lockTtlMs ?? 30000;

    const freeSlots = concurrency - this.activeJobs.size;
    if (freeSlots <= 0) return;

    // 1. Claim IDs from Broker with ordering strategy
    const strategy: BrokerStrategy =
      q.strategy ?? this.config.taskQueue?.strategy ?? "fifo";
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

      const p = this.executeJob(job, q).finally(() => {
        this.activeJobs.delete(id);
      });
      this.activeJobs.set(id, p);
    }
  }

  private async executeJob(job: OqronJob, q: TaskQueueConfig): Promise<void> {
    let internalDiscarded = false;
    const lockTtlMs = q.lockTtlMs ?? this.config.taskQueue?.lockTtlMs ?? 30000;
    const heartbeatMs =
      q.heartbeatMs ?? this.config.taskQueue?.heartbeatMs ?? 5000;
    const useGuaranteed = q.guaranteedWorker !== false;

    // Resolve retry config: per-queue → global → default
    const maxRetries =
      q.retries?.max ?? this.config.taskQueue?.retries?.max ?? 0;
    const retryStrategy =
      q.retries?.strategy ??
      this.config.taskQueue?.retries?.strategy ??
      "exponential";
    const baseDelay =
      q.retries?.baseDelay ?? this.config.taskQueue?.retries?.baseDelay ?? 2000;
    const maxDelay =
      q.retries?.maxDelay ?? this.config.taskQueue?.retries?.maxDelay ?? 60000;

    // Per-job attempts override takes highest priority
    const effectiveMaxRetries = job.opts?.attempts
      ? job.opts.attempts - 1
      : maxRetries;

    // ── Start HeartbeatWorker for crash-safe lock renewal ─────────────────
    let heartbeat: HeartbeatWorker | null = null;
    if (useGuaranteed) {
      const lockKey = `taskqueue:job:${job.id}`;
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

    const ctx: TaskJobContext<any> = {
      id: job.id,
      data: job.data,
      signal: abortController.signal,
      progress: async (percent, label) => {
        job.progressPercent = percent;
        job.progressLabel = label;
        await this.di.storage.save("jobs", job.id, job);
        OqronEventBus.emit("job:progress", job.queueName, job.id, percent);
      },
      log: (level, msg) => {
        const method = this.logger[level] || this.logger.info;
        method.call(this.logger, `[TaskJob:${q.name}] ${msg}`, {
          jobId: job.id,
        });
      },
      discard: () => {
        internalDiscarded = true;
      },
    };

    // Update state to active
    job.status = "active";
    job.workerId = this.workerIdStr;
    job.startedAt = new Date();
    job.attemptMade = (job.attemptMade ?? 0) + 1;
    await this.di.storage.save("jobs", job.id, job);

    OqronEventBus.emit("job:start", job.queueName, job.id, q.name);

    let status: "completed" | "failed" = "completed";
    let error: string | undefined;
    let result: any;

    try {
      result = await q.handler(ctx);

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
        this.logger.info(`TaskQueue job ${job.id} was cancelled`);
      }
      // Check if we should retry via nack (broker-level, crash-safe)
      else if (!internalDiscarded && job.attemptMade <= effectiveMaxRetries) {
        const backoffOpts = job.opts?.backoff ?? {
          type: retryStrategy,
          delay: baseDelay,
        };
        const delay = calculateBackoff(backoffOpts, job.attemptMade, maxDelay);

        this.logger.warn("TaskQueue job failed, re-queuing for retry...", {
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
      this.logger.error("TaskQueue job failed permanently", {
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
        void Promise.resolve().then(() =>
          q.hooks!.onSuccess!(job as any, result),
        );
      }
    } else {
      const errorObject = new Error(error ?? "Unknown error");
      OqronEventBus.emit("job:fail", job.queueName, job.id, errorObject);

      if (q.hooks?.onFail) {
        void Promise.resolve().then(() =>
          q.hooks!.onFail!(job as any, errorObject),
        );
      }

      // DLQ: invoke dead letter hook if enabled and retries exhausted
      const dlqEnabled =
        q.deadLetter?.enabled ?? this.config.taskQueue?.deadLetter?.enabled;
      if (dlqEnabled && q.deadLetter?.onDead) {
        void Promise.resolve().then(() =>
          q.deadLetter!.onDead!(job as any).catch((e) =>
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
          ? this.config.taskQueue?.removeOnComplete
          : this.config.taskQueue?.removeOnFail,
      filterKey: "queueName",
      filterValue: q.name,
    });
  }
}
