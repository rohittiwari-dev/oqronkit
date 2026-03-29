import { randomUUID } from "node:crypto";
import { Worker as ThreadWorker } from "node:worker_threads";
import type { IOqronModule, Logger } from "../engine/index.js";
import { OqronContainer, OqronEventBus } from "../engine/index.js";
import { HeartbeatWorker } from "../engine/lock/heartbeat-worker.js";
import { StallDetector } from "../engine/lock/stall-detector.js";
import type { OqronConfig } from "../engine/types/config.types.js";
import type { BrokerStrategy, IBrokerEngine } from "../engine/types/engine.js";
import type { OqronJob } from "../engine/types/job.types.js";
import { calculateBackoff } from "../engine/utils/backoffs.js";
import { pruneAfterCompletion } from "../engine/utils/job-retention.js";
import { getRegisteredWorkers, type Worker } from "./worker.js";

export class WorkerEngine implements IOqronModule {
  public readonly name = "worker";
  public readonly enabled = true;
  private running = false;
  private timers: NodeJS.Timeout[] = [];
  private workerIdStr = randomUUID();
  private activeJobs = new Map<string, Promise<void>>();
  /** Active heartbeat workers keyed by job ID */
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
    if (!modules.includes("worker")) return;

    const workers = getRegisteredWorkers();
    this.logger.info(
      `Initialized distributed WorkerEngine controlling ${workers.length} nodes`,
    );
  }

  async start(): Promise<void> {
    const modules = this.config.modules || [];
    if (!modules.includes("worker")) return;
    if (this.running) return;

    this.running = true;
    const workers = getRegisteredWorkers();
    for (const w of workers) {
      if (w.options?.autorun !== false) {
        w.start();
        this.startPolling(w);
      }
    }

    // Start stall detector
    const stalledInterval = this.config.worker?.stalledInterval ?? 30000;
    this.stallDetector = new StallDetector(
      this.di.lock,
      this.logger,
      stalledInterval,
    );
    this.stallDetector.start(
      () =>
        Array.from(this.heartbeats.entries()).map(([jobId]) => ({
          key: `worker:job:${jobId}`,
          ownerId: this.workerIdStr,
        })),
      (key: string) => {
        const jobId = key.replace("worker:job:", "");
        this.logger.warn(
          `Stall detected for Worker job ${jobId} — nacking back to broker`,
        );
        this.heartbeats.get(jobId)?.stop();
        this.heartbeats.delete(jobId);
        // Find the worker for this job and nack it back
        const workerName = workers.find((_w) =>
          this.activeJobs.has(jobId),
        )?.name;
        if (workerName) {
          const broker =
            workers.find((w) => w.name === workerName)?.options?.connection ??
            this.di.broker;
          void broker.nack(workerName, jobId);
        }
      },
    );
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];

    const workers = getRegisteredWorkers();
    for (const w of workers) w.stop();

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

    const active = Array.from(this.activeJobs.values());
    if (active.length > 0) {
      this.logger.info(
        `WorkerEngine waiting for ${active.length} active executions to drain...`,
      );
      const timeout = this.config.worker?.shutdownTimeout ?? 25000;
      await Promise.race([
        Promise.allSettled(active),
        new Promise((r) => setTimeout(r, timeout)),
      ]);
    }
  }

  async triggerManual(id: string): Promise<boolean> {
    const w = getRegisteredWorkers().find((w) => w.name === id);
    if (w) {
      await this.poll(w);
      return true;
    }
    return false;
  }

  /**
   * Cancel an actively running job via AbortController.
   * Aborts the handler, stops the heartbeat, marks the job as failed.
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

  private startPolling(w: Worker) {
    const heartbeatMs = this.config.worker?.heartbeatMs ?? 5000;
    const t = setInterval(() => {
      this.poll(w).catch((e) =>
        this.logger.error(`Worker poller crashed for ${w.name}`, e),
      );
    }, heartbeatMs);
    this.timers.push(t);

    setTimeout(() => this.poll(w), 0);
  }

  private async poll(w: Worker): Promise<void> {
    if (!this.running || !w.running) return;

    const concurrency =
      w.options?.concurrency ?? this.config.worker?.concurrency ?? 5;
    const lockTtlMs = this.config.worker?.lockTtlMs ?? 30000;

    const freeSlots = concurrency - this.activeJobs.size;
    if (freeSlots <= 0) return;

    const broker = w.options?.connection ?? this.di.broker;

    // Claim IDs from Broker with ordering strategy
    const strategy: BrokerStrategy =
      w.options?.strategy ?? this.config.worker?.strategy ?? "fifo";
    const jobIds = await broker.claim(
      w.name,
      this.workerIdStr,
      freeSlots,
      lockTtlMs,
      strategy,
    );

    for (const id of jobIds) {
      // Fetch full payload from Storage
      const job = await this.di.storage.get<OqronJob>("jobs", id);
      if (!job) {
        this.logger.error(`Claimed job ${id} not found in Storage!`, { id });
        await broker.ack(w.name, id);
        continue;
      }

      // Environment isolation
      if (
        job.environment &&
        this.config.environment &&
        job.environment !== this.config.environment
      ) {
        this.logger.debug(`Skipping job ${id} — wrong environment`, {
          jobEnv: job.environment,
          workerEnv: this.config.environment,
        });
        continue;
      }

      const p = this.executeJob(job, w, broker).finally(() =>
        this.activeJobs.delete(id),
      );
      this.activeJobs.set(id, p);
    }
  }

  private async executeJob(
    job: OqronJob,
    w: Worker,
    broker: IBrokerEngine,
  ): Promise<void> {
    const lockTtlMs = this.config.worker?.lockTtlMs ?? 30000;
    const heartbeatMs = this.config.worker?.heartbeatMs ?? 5000;

    // Resolve retry config: per-worker → global → default
    const maxRetries =
      w.options?.retries?.max ?? this.config.worker?.retries?.max ?? 0;
    const retryStrategy =
      w.options?.retries?.strategy ??
      this.config.worker?.retries?.strategy ??
      "exponential";
    const baseDelay =
      w.options?.retries?.baseDelay ??
      this.config.worker?.retries?.baseDelay ??
      2000;
    const maxDelay =
      w.options?.retries?.maxDelay ??
      this.config.worker?.retries?.maxDelay ??
      60000;

    // Per-job attempts override
    const effectiveMaxRetries = job.opts?.attempts
      ? job.opts.attempts - 1
      : maxRetries;

    // ── Start HeartbeatWorker for crash-safe lock renewal ─────────────────
    const lockKey = `worker:job:${job.id}`;
    const heartbeat = new HeartbeatWorker(
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
      await broker.nack(w.name, job.id);
      return;
    }
    this.heartbeats.set(job.id, heartbeat);

    // ── Create AbortController for cancellation support ────────────────────
    const abortController = new AbortController();
    this.abortControllers.set(job.id, abortController);

    OqronEventBus.emit("job:start", job.queueName, job.id, job.queueName);

    // Update DB to active
    job.status = "active";
    job.workerId = this.workerIdStr;
    job.startedAt = new Date();
    job.attemptMade = (job.attemptMade ?? 0) + 1;
    await this.di.storage.save("jobs", job.id, job);

    let status: "completed" | "failed" = "completed";
    let error: string | undefined;
    let result: any;

    try {
      if (typeof w.processor === "string") {
        result = await new Promise((resolve, reject) => {
          const thread = new ThreadWorker(w.processor as string, {
            workerData: job,
          });
          thread.on("message", resolve);
          thread.on("error", reject);
          thread.on("exit", (code) => {
            if (code !== 0) reject(new Error(`Thread exited: ${code}`));
          });
        });
      } else {
        result = await w.processor(job as any);
      }

      // Check if cancelled mid-execution
      if (abortController.signal.aborted) {
        throw new Error("Cancelled");
      }

      status = "completed";
      error = undefined;
    } catch (e: any) {
      error = e.message ?? "Unknown error";
      status = "failed";
      job.stacktrace = e.stack ? [e.stack] : [];

      // If cancelled, don't retry
      if (abortController.signal.aborted) {
        this.logger.info(`Worker job ${job.id} was cancelled`);
      }
      // Check for broker-level retry via nack
      else if (job.attemptMade <= effectiveMaxRetries) {
        const backoffOpts = job.opts?.backoff ?? {
          type: retryStrategy,
          delay: baseDelay,
        };
        const delay = calculateBackoff(backoffOpts, job.attemptMade, maxDelay);

        this.logger.warn("Worker job failed, re-queuing for retry...", {
          worker: w.name,
          jobId: job.id,
          attempt: job.attemptMade,
          nextIn: `${delay}ms`,
          error,
        });

        job.status = "delayed";
        job.error = error;
        await this.di.storage.save("jobs", job.id, job);

        // Stop heartbeat before nack
        await heartbeat.stop();
        this.heartbeats.delete(job.id);
        this.abortControllers.delete(job.id);

        // Nack back to broker with delay — crash-safe
        await broker.nack(w.name, job.id, delay);
        return;
      }

      this.logger.error(`Worker job ${job.id} failed permanently`, {
        worker: w.name,
        attempts: job.attemptMade,
        error,
      });
    }

    // ── Clean up abort controller ────────────────────────────────────────
    this.abortControllers.delete(job.id);

    // ── Stop heartbeat ──────────────────────────────────────────────────
    await heartbeat.stop();
    this.heartbeats.delete(job.id);

    // ── Finalize ─────────────────────────────────────────────────────────
    job.status = status;
    job.finishedAt = new Date();
    job.error = error;

    if (status === "completed") {
      job.returnValue = result;
      job.progressPercent = 100;
      job.progressLabel = "Completed";
    }

    await this.di.storage.save("jobs", job.id, job);
    await broker.ack(job.queueName, job.id);

    // ── Events & Hooks ──────────────────────────────────────────────────
    if (status === "completed") {
      OqronEventBus.emit("job:success", job.queueName, job.id);

      if (w.options?.hooks?.onSuccess) {
        void Promise.resolve().then(() =>
          w.options!.hooks!.onSuccess!(job as any, result),
        );
      }
    } else {
      const errorObject = new Error(error ?? "Unknown error");
      OqronEventBus.emit("job:fail", job.queueName, job.id, errorObject);

      if (w.options?.hooks?.onFail) {
        void Promise.resolve().then(() =>
          w.options!.hooks!.onFail!(job as any, errorObject),
        );
      }

      // DLQ
      const dlqEnabled =
        w.options?.deadLetter?.enabled ??
        this.config.worker?.deadLetter?.enabled;
      if (dlqEnabled && w.options?.deadLetter?.onDead) {
        void Promise.resolve().then(() =>
          w.options!.deadLetter!.onDead!(job as any).catch((e) =>
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
        status === "completed"
          ? w.options?.removeOnComplete
          : w.options?.removeOnFail,
      globalRemoveConfig:
        status === "completed"
          ? this.config.worker?.removeOnComplete
          : this.config.worker?.removeOnFail,
      filterKey: "queueName",
      filterValue: w.name,
    });
  }
}
