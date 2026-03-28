import { randomUUID } from "node:crypto";
import type { IOqronModule, Logger } from "../core/index.js";
import { OqronEventBus } from "../core/index.js";
import type { OqronConfig } from "../core/types/config.types.js";
import type { IQueueAdapter, OqronJobData } from "../core/types/queue.types.js";
import { MemoryQueueAdapter } from "../queue/adapters/memory-queue.js";
import { getRegisteredTaskQueues, injectTaskQueueAdapter } from "./registry.js";
import type { TaskJobContext, TaskQueueConfig } from "./types.js";

export class TaskQueueEngine implements IOqronModule {
  public readonly name = "taskQueue";
  public readonly enabled = true;
  private running = false;
  private adapter!: IQueueAdapter;
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

    // TODO: Dynamically wire Redis/DB adapter if config.broker is provided
    // For V1 Phase 1, we aggressively rely on the Memory adapter to prove the engine works natively.
    this.adapter = new MemoryQueueAdapter();
    injectTaskQueueAdapter(this.adapter);

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
    this.logger.warn(
      `Manual trigger called for taskQueue ${id}. This forces the poller immediately.`,
    );
    const q = getRegisteredTaskQueues().find((q) => q.name === id);
    if (q) {
      await this.poll(q);
      return true;
    }
    return false;
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const t of this.timers) {
      clearInterval(t);
    }
    this.timers = [];

    // Wait for active task promises to settle for graceful shutdown
    const allActive = Array.from(this.activeJobs.values());
    if (allActive.length > 0) {
      this.logger.info(
        `TaskQueueEngine draining ${allActive.length} active monolithic jobs...`,
      );
      await Promise.allSettled(allActive);
    }
  }

  private startPolling(q: TaskQueueConfig) {
    const heartbeatMs =
      q.heartbeatMs ?? this.config.taskQueue?.heartbeatMs ?? 5000;

    // Safety interval
    const t = setInterval(() => {
      this.poll(q).catch((e) =>
        this.logger.error(`TaskQueue poller crashed for ${q.name}`, e),
      );
    }, heartbeatMs);

    this.timers.push(t);

    // Trigger initial poll immediately
    setTimeout(() => this.poll(q), 0);
  }

  private async poll(q: TaskQueueConfig): Promise<void> {
    if (!this.running) return;

    const concurrency =
      q.concurrency ?? this.config.taskQueue?.concurrency ?? 5;
    const lockTtlMs = q.lockTtlMs ?? this.config.taskQueue?.lockTtlMs ?? 30000;

    // Prevent pulling more jobs if we are globally constrained
    const freeSlots = concurrency - Array.from(this.activeJobs.values()).length;
    if (freeSlots <= 0) return; // Completely saturated for this specific queue instance

    const jobs = await this.adapter.claimJobs(
      q.name,
      freeSlots,
      this.workerIdStr,
      lockTtlMs,
    );
    if (jobs.length > 0) {
      this.logger.debug(
        `[TaskQueue: ${q.name}] Claimed ${jobs.length} jobs directly into monolithic memory.`,
      );
    }

    for (const job of jobs) {
      const p = this.executeJob(job, q).finally(() => {
        this.activeJobs.delete(job.id);
      });
      this.activeJobs.set(job.id, p);
    }
  }

  private async executeJob(
    job: OqronJobData,
    q: TaskQueueConfig,
  ): Promise<void> {
    let internalDiscarded = false;

    const ctx: TaskJobContext<any> = {
      id: job.id,
      data: job.data,
      progress: async (percent, label) => {
        await this.adapter.updateProgress(job.id, percent, label);
      },
      log: (level, msg) => {
        const method = this.logger[level] || this.logger.info;
        method.call(this.logger, `[TaskJob] ${msg}`);
      },
      discard: () => {
        internalDiscarded = true;
      },
    };

    try {
      // Fire event telemetry tracking via EventBus
      OqronEventBus.emit("job:start", job.queueName, job.id, q.name);

      const result = await q.handler(ctx);

      if (internalDiscarded) {
        throw new Error(
          "[OqronKit] Forced internal discard invoked inside handler",
        );
      }

      await this.adapter.completeJob(job.id, result);
      OqronEventBus.emit("job:success", job.queueName, job.id);

      if (q.hooks?.onSuccess) {
        // Execute asynchronously avoiding pipeline halts
        Promise.resolve()
          .then(() => q.hooks!.onSuccess!(job, result))
          .catch((e) =>
            this.logger.error(
              `[TaskQueue ${q.name}] onSuccess hook exception`,
              e,
            ),
          );
      }
    } catch (e: any) {
      const errorObject = new Error(e.message ?? "Unknown error");
      if (internalDiscarded) {
        // Drop permanently with no retry logic applied.
        await this.adapter.failJob(job.id, "Discarded", e.stack);
      } else {
        await this.adapter.failJob(
          job.id,
          e.message || "Unknown error",
          e.stack,
        );
      }
      OqronEventBus.emit("job:fail", job.queueName, job.id, errorObject);

      if (q.hooks?.onFail) {
        Promise.resolve()
          .then(() => q.hooks!.onFail!(job, errorObject))
          .catch((err) =>
            this.logger.error(
              `[TaskQueue ${q.name}] onFail hook exception`,
              err,
            ),
          );
      }
    }
  }
}
