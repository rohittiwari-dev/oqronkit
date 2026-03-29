import { randomUUID } from "node:crypto";
import { Worker as ThreadWorker } from "node:worker_threads";
import { AdapterRegistry } from "../../core/adapter-registry.js";
import type { IOqronModule, Logger } from "../../core/index.js";
import { OqronEventBus } from "../../core/index.js";
import type { OqronConfig } from "../../core/types/config.types.js";
import type { IOqronAdapter } from "../../core/types/db.types.js";
import type { OqronJob } from "../../core/types/job.types.js";
import type { IQueueAdapter } from "../../core/types/queue.types.js";
import { getRegisteredWorkers, type Worker } from "./worker.js";

export class WorkerEngine implements IOqronModule {
  public readonly name = "worker";
  public readonly enabled = true;
  private running = false;
  private timers: NodeJS.Timeout[] = [];
  private workerIdStr = randomUUID();
  private activeJobs = new Map<string, Promise<void>>();

  private sharedBroker!: IQueueAdapter;
  private sharedDb!: IOqronAdapter;

  constructor(
    private config: OqronConfig,
    private logger: Logger,
  ) {}

  async init(): Promise<void> {
    const modules = this.config.modules || [];
    if (!modules.includes("worker")) return;

    const registry = AdapterRegistry.from(this.config);
    this.sharedBroker = registry.resolveBroker();
    this.sharedDb = registry.resolveDb();

    const workers = getRegisteredWorkers();
    this.logger.info(
      `Initialized distributed WorkerEngine (Dual-Storage Model) controlling ${workers.length} nodes`,
      {
        broker: (this.sharedBroker as any).constructor?.name ?? "unknown",
        db: (this.sharedDb as any).constructor?.name ?? "unknown",
      },
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
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];

    const workers = getRegisteredWorkers();
    for (const w of workers) w.stop();

    const active = Array.from(this.activeJobs.values());
    if (active.length > 0) {
      this.logger.info(
        `WorkerEngine waiting for ${active.length} active executions to drain...`,
      );
      await Promise.allSettled(active);
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

    const broker = w.options?.connection ?? this.sharedBroker;

    // Claim IDs from Broker
    const jobIds = await broker.claimJobIds(
      w.name,
      this.workerIdStr,
      freeSlots,
      lockTtlMs,
    );

    for (const id of jobIds) {
      // Fetch full payload from DB
      const job = await this.sharedDb.getJob(id);
      if (!job) {
        this.logger.error(`Claimed job ${id} not found in DB!`, { id });
        await broker.ack(id);
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
    broker: IQueueAdapter,
  ): Promise<void> {
    try {
      OqronEventBus.emit("job:start", job.queueName, job.id, job.queueName);

      // Update DB to active
      job.status = "active";
      job.workerId = this.workerIdStr;
      job.startedAt = new Date();
      job.attemptMade += 1;
      await this.sharedDb.upsertJob(job);

      let result: any;
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

      // Success Path
      job.status = "completed";
      job.finishedAt = new Date();
      job.returnValue = result;
      job.progressPercent = 100;
      job.progressLabel = "Completed";

      await this.sharedDb.upsertJob(job);
      await broker.ack(job.id);

      OqronEventBus.emit("job:success", job.queueName, job.id);

      if (w.options?.hooks?.onSuccess) {
        void Promise.resolve().then(() =>
          w.options!.hooks!.onSuccess!(job as any, result),
        );
      }
    } catch (e: any) {
      this.logger.error(`Job ${job.id} failed`, e);

      const errorObject = new Error(e.message ?? "Unknown error");
      job.status = "failed"; // Logic for retries should be here or in DB
      job.error = e.message;
      job.stacktrace = [e.stack];
      job.finishedAt = new Date();

      await this.sharedDb.upsertJob(job);
      await broker.ack(job.id);

      OqronEventBus.emit("job:fail", job.queueName, job.id, errorObject);

      if (w.options?.hooks?.onFail) {
        void Promise.resolve().then(() =>
          w.options!.hooks!.onFail!(job as any, errorObject),
        );
      }
    }
  }
}
