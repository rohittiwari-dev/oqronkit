import { randomUUID } from "node:crypto";
import type { IOqronModule, Logger } from "../../core/index.js";
import { OqronEventBus } from "../../core/index.js";
import type { OqronConfig } from "../../core/types/config.types.js";
import type {
  IQueueAdapter,
  OqronJobData,
} from "../../core/types/queue.types.js";
import { getRegisteredWorkers, type Worker } from "./worker.js";

export class WorkerEngine implements IOqronModule {
  public readonly name = "worker";
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
    this.logger.warn(`Manual worker trigger invoked for queue ${id}.`);
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

    // Immediate startup poll
    setTimeout(() => this.poll(w), 0);
  }

  private async poll(w: Worker): Promise<void> {
    if (!this.running || !w.running) return;

    const concurrency =
      w.options?.concurrency ?? this.config.worker?.concurrency ?? 5;
    const lockTtlMs = this.config.worker?.lockTtlMs ?? 30000;

    const freeSlots = concurrency - Array.from(this.activeJobs.values()).length;
    if (freeSlots <= 0) return;

    let adapter: IQueueAdapter;
    try {
      adapter = w.getAdapter();
    } catch {
      return;
    } // Handled natively if missing

    const jobs = await adapter.claimJobs(
      w.name,
      freeSlots,
      this.workerIdStr,
      lockTtlMs,
    );
    for (const job of jobs) {
      const p = this.executeJob(job, w, adapter).finally(() =>
        this.activeJobs.delete(job.id),
      );
      this.activeJobs.set(job.id, p);
    }
  }

  private async executeJob(
    job: OqronJobData,
    w: Worker,
    adapter: IQueueAdapter,
  ): Promise<void> {
    try {
      OqronEventBus.emit("job:start", job.queueName, job.id, w.name);

      const result = await w.processor(job);
      await adapter.completeJob(job.id, result);
      OqronEventBus.emit("job:success", job.queueName, job.id);

      if (w.options?.hooks?.onSuccess) {
        Promise.resolve()
          .then(() => w.options!.hooks!.onSuccess!(job, result))
          .catch((e) =>
            this.logger.error(`[Worker ${w.name}] onSuccess hook error`, e),
          );
      }
    } catch (e: any) {
      const errorObject = new Error(e.message ?? "Unknown error");
      await adapter.failJob(
        job.id,
        e.message || "Worker execution failed",
        e.stack,
      );
      OqronEventBus.emit("job:fail", job.queueName, job.id, errorObject);

      if (w.options?.hooks?.onFail) {
        Promise.resolve()
          .then(() => w.options!.hooks!.onFail!(job, errorObject))
          .catch((err) =>
            this.logger.error(`[Worker ${w.name}] onFail hook error`, err),
          );
      }
    }
  }
}
