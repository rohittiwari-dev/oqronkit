import { randomUUID } from "node:crypto";
import { Broker, Storage } from "../engine/index.js";
import type { OqronJob } from "../engine/types/job.types.js";
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
      await Storage.save("jobs", jobId, job);

      // 2. Transport
      await Broker.publish(config.name, jobId, opts?.delay);

      return job as any;
    },
  };
}
