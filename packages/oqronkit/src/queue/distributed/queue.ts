import { randomUUID } from "node:crypto";
import type { OqronJob, OqronJobOptions } from "../../core/types/job.types.js";
import { OqronKit } from "../../index.js";

export interface QueueOptions {
  defaultJobOptions?: OqronJobOptions;
}

/**
 * Enterprise Queue Publisher.
 * Modeled after BullMQ. This class is strictly a sender and consumes no CPU/polling loops.
 * Follows the Dual-Storage Model: DB for persistence, Broker for signaling.
 */
export class Queue<T = any, R = any> {
  constructor(
    public readonly name: string,
    private options?: QueueOptions,
  ) {}

  /**
   * Pushes a new job into the persistent data store and signals the broker.
   */
  async add(
    _name: string,
    data: T,
    opts?: OqronJobOptions,
  ): Promise<OqronJob<T, R>> {
    const finalOpts = { ...this.options?.defaultJobOptions, ...opts };
    const jobId = finalOpts.jobId ?? randomUUID();

    const job: OqronJob<T, R> = {
      id: jobId,
      type: "task",
      queueName: this.name,
      status: finalOpts.delay ? "delayed" : "waiting",
      data,
      opts: finalOpts,
      attemptMade: 0,
      progressPercent: 0,
      tags: [],
      createdAt: new Date(),
      runAt: finalOpts.delay
        ? new Date(Date.now() + finalOpts.delay)
        : undefined,
    };

    const db = OqronKit.getDb();
    const broker = OqronKit.getBroker();

    // 1. Persist to DB (Source of Truth)
    await db.upsertJob(job);

    // 2. Signal Broker (Execution Trigger)
    await broker.signalEnqueue(this.name, jobId, finalOpts.delay);

    return job;
  }

  /**
   * Push multiple jobs asynchronously in bulk.
   */
  async addBulk(
    jobs: { name: string; data: T; opts?: OqronJobOptions }[],
  ): Promise<OqronJob<T, R>[]> {
    const results: OqronJob<T, R>[] = [];
    for (const j of jobs) {
      results.push(await this.add(j.name, j.data, j.opts));
    }
    return results;
  }

  async close(): Promise<void> {}
}
