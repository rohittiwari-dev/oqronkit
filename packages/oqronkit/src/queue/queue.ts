import { randomUUID } from "node:crypto";
import { Broker, Storage } from "../engine/index.js";
import type { OqronJob, OqronJobOptions } from "../engine/types/job.types.js";

export interface QueueOptions {
  defaultJobOptions?: OqronJobOptions;
}

/**
 * Enterprise Queue Publisher.
 * Modeled after Industrygrade. This class is strictly a sender and consumes no CPU/polling loops.
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

    // 1. Persist to Storage (Source of Truth)
    await Storage.save("jobs", jobId, job);

    // 2. Signal Broker (Execution Trigger)
    await Broker.publish(this.name, jobId, finalOpts.delay);

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
