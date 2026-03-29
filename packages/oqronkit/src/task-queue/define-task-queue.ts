import { randomUUID } from "node:crypto";
import type { OqronJob } from "../core/types/job.types.js";
import { OqronKit } from "../index.js";
import { registerTaskQueue } from "./registry.js";
import type { ITaskQueue, TaskQueueConfig } from "./types.js";

/**
 * Enterprise Task Queue Factory.
 * Simple API for monolithic applications where publisher and worker live together.
 */
export function taskQueue<T = any, R = any>(
  config: TaskQueueConfig<T, R>,
): ITaskQueue<T, R> {
  registerTaskQueue(config);

  return {
    name: config.name,
    add: async (data, opts) => {
      const db = OqronKit.getDb();
      const broker = OqronKit.getBroker();
      const jobId = opts?.jobId ?? randomUUID();

      const job: OqronJob = {
        id: jobId,
        type: "task",
        queueName: config.name,
        status: opts?.delay ? "delayed" : "waiting",
        data,
        opts: opts ?? {},
        attemptMade: 0,
        progressPercent: 0,
        tags: [],
        createdAt: new Date(),
        runAt: opts?.delay ? new Date(Date.now() + opts.delay) : undefined,
      };

      // 1. Storage
      await db.upsertJob(job);

      // 2. Transport
      await broker.signalEnqueue(config.name, jobId, opts?.delay);

      return job as any;
    },
  };
}
