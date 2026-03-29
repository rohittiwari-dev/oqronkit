import { randomUUID } from "node:crypto";
import type { IOqronModule, Logger } from "../core/index.js";
import { OqronEventBus } from "../core/index.js";
import type { OqronConfig } from "../core/types/config.types.js";
import type { IOqronAdapter } from "../core/types/db.types.js";
import type { OqronJob } from "../core/types/job.types.js";
import type { IQueueAdapter } from "../core/types/queue.types.js";
import { OqronKit } from "../index.js";
import { getRegisteredTaskQueues } from "./registry.js";
import type { TaskJobContext, TaskQueueConfig } from "./types.js";

export class TaskQueueEngine implements IOqronModule {
  public readonly name = "taskQueue";
  public readonly enabled = true;
  private running = false;
  private timers: NodeJS.Timeout[] = [];
  private workerIdStr = randomUUID();
  private activeJobs = new Map<string, Promise<void>>();

  private broker!: IQueueAdapter;
  private db!: IOqronAdapter;

  constructor(
    private config: OqronConfig,
    private logger: Logger,
  ) {}

  async init(): Promise<void> {
    const modules = this.config.modules || [];
    if (!modules.includes("taskQueue")) return;

    this.broker = OqronKit.getBroker();
    this.db = OqronKit.getDb();

    const qs = getRegisteredTaskQueues();
    this.logger.info(
      `Initialized monolithic TaskQueue engine (Dual-Storage) covering ${qs.length} endpoints`,
      { broker: (this.broker as any).constructor?.name ?? "unknown" },
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
      await Promise.allSettled(allActive);
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
    const jobIds = await this.broker.claimJobIds(
      q.name,
      this.workerIdStr,
      freeSlots,
      lockTtlMs,
    );

    for (const id of jobIds) {
      // 2. Fetch full payload from DB
      const job = await this.db.getJob(id);
      if (!job) {
        this.logger.error(`Claimed job ${id} not found in DB!`, { id });
        await this.broker.ack(id);
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

    const ctx: TaskJobContext<any> = {
      id: job.id,
      data: job.data,
      progress: async (percent, label) => {
        await this.db.upsertJob({
          ...job,
          progressPercent: percent,
          progressLabel: label,
        });
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
      OqronEventBus.emit("job:start", job.queueName, job.id, q.name);

      // Update state to active in DB
      job.status = "active";
      job.workerId = this.workerIdStr;
      job.startedAt = new Date();
      job.attemptMade += 1;
      await this.db.upsertJob(job);

      const result = await q.handler(ctx);

      if (internalDiscarded) throw new Error("Discarded");

      // Update state to completed in DB
      job.status = "completed";
      job.finishedAt = new Date();
      job.returnValue = result;
      job.progressPercent = 100;
      job.progressLabel = "Completed";

      await this.db.upsertJob(job);
      await this.broker.ack(job.id);

      OqronEventBus.emit("job:success", job.queueName, job.id);

      if (q.hooks?.onSuccess) {
        void Promise.resolve().then(() =>
          q.hooks!.onSuccess!(job as any, result),
        );
      }
    } catch (e: any) {
      const errorObject = new Error(e.message ?? "Unknown error");
      job.status = internalDiscarded ? "failed" : "failed"; // Retry logic needed here
      job.error = e.message;
      job.stacktrace = [e.stack];
      job.finishedAt = new Date();

      await this.db.upsertJob(job);
      await this.broker.ack(job.id);

      OqronEventBus.emit("job:fail", job.queueName, job.id, errorObject);

      if (q.hooks?.onFail) {
        void Promise.resolve().then(() =>
          q.hooks!.onFail!(job as any, errorObject),
        );
      }
    }
  }
}
