import { randomUUID } from "node:crypto";
import type { IOqronModule, Logger } from "../engine/index.js";
import { Broker, OqronEventBus, Storage } from "../engine/index.js";
import type { OqronConfig } from "../engine/types/config.types.js";
import type { OqronJob } from "../engine/types/job.types.js";
import { calculateBackoff } from "../engine/utils/backoffs.js";
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

  constructor(
    private config: OqronConfig,
    private logger: Logger,
  ) {}

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
  }

  async triggerManual(id: string): Promise<boolean> {
    const q = getRegisteredTaskQueues().find((q) => q.name === id);
    if (q) {
      await this.poll(q);
      return true;
    }
    return false;
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];

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

    // 1. Claim IDs from Broker
    const jobIds = await Broker.claim(
      q.name,
      this.workerIdStr,
      freeSlots,
      lockTtlMs,
    );

    for (const id of jobIds) {
      // 2. Fetch full payload from Storage
      const job = await Storage.get<OqronJob>("jobs", id);
      if (!job) {
        this.logger.error(`Claimed job ${id} not found in Storage!`, { id });
        await Broker.ack(q.name, id);
        continue;
      }

      // Environment isolation: skip jobs from different environments
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

      const p = this.executeJob(job, q).finally(() => {
        this.activeJobs.delete(id);
      });
      this.activeJobs.set(id, p);
    }
  }

  private async executeJob(job: OqronJob, q: TaskQueueConfig): Promise<void> {
    let internalDiscarded = false;

    // Resolve retry config: per-queue → global → default
    const maxAttempts =
      (q.retries?.max ?? this.config.taskQueue?.retries?.max ?? 0) + 1;
    const retryStrategy =
      q.retries?.strategy ??
      this.config.taskQueue?.retries?.strategy ??
      "exponential";
    const baseDelay =
      q.retries?.baseDelay ?? this.config.taskQueue?.retries?.baseDelay ?? 2000;
    const maxDelay =
      q.retries?.maxDelay ?? this.config.taskQueue?.retries?.maxDelay ?? 60000;

    // Per-job attempts override takes highest priority
    const effectiveMaxAttempts = job.opts?.attempts
      ? job.opts.attempts
      : maxAttempts;

    const ctx: TaskJobContext<any> = {
      id: job.id,
      data: job.data,
      progress: async (percent, label) => {
        job.progressPercent = percent;
        job.progressLabel = label;
        await Storage.save("jobs", job.id, job);
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
    job.attemptMade += 1;
    await Storage.save("jobs", job.id, job);

    OqronEventBus.emit("job:start", job.queueName, job.id, q.name);

    let attempts = 1;
    let status: "completed" | "failed" = "completed";
    let error: string | undefined;
    let result: any;

    while (attempts <= effectiveMaxAttempts) {
      try {
        result = await q.handler(ctx);

        if (internalDiscarded) {
          throw new Error("Job discarded by handler");
        }

        // ── Success ───────────────────────────────────────────────────────
        status = "completed";
        error = undefined;
        break;
      } catch (e: any) {
        error = e.message ?? "Unknown error";
        status = "failed";

        if (attempts < effectiveMaxAttempts && !internalDiscarded) {
          // Calculate backoff delay
          const backoffOpts = job.opts?.backoff ?? {
            type: retryStrategy,
            delay: baseDelay,
          };
          const delay = calculateBackoff(backoffOpts, attempts, maxDelay);

          this.logger.warn("TaskQueue job failed, retrying...", {
            name: q.name,
            jobId: job.id,
            attempt: attempts,
            nextIn: `${delay}ms`,
            error,
          });

          // Update state to delayed during retry wait
          job.status = "delayed";
          job.attemptMade = attempts;
          await Storage.save("jobs", job.id, job);

          attempts++;
          await new Promise((resolve) => setTimeout(resolve, delay));

          // Update back to active for next attempt
          job.status = "active";
          job.attemptMade = attempts;
          await Storage.save("jobs", job.id, job);
        } else {
          // All retries exhausted
          this.logger.error("TaskQueue job failed permanently", {
            name: q.name,
            jobId: job.id,
            attempts,
            error,
          });

          // Capture stacktrace
          job.stacktrace = e.stack ? [e.stack] : [];

          break;
        }
      }
    }

    // ── Finalize ─────────────────────────────────────────────────────────
    const finishedAt = new Date();
    job.status = status;
    job.finishedAt = finishedAt;
    job.error = error;
    job.attemptMade = attempts;

    if (status === "completed") {
      job.returnValue = result;
      job.progressPercent = 100;
      job.progressLabel = "Completed";
    }

    await Storage.save("jobs", job.id, job);
    await Broker.ack(q.name, job.id);

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
