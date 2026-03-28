import type {
  OqronJobData,
  OqronJobOptions,
} from "../core/types/queue.types.js";
import { getTaskQueueAdapter, registerTaskQueue } from "./registry.js";
import type { ITaskQueue, TaskQueueConfig } from "./types.js";

/**
 * Define a highly reliable monolithic Task Queue.
 * In a monolithic architecture, the server calling `.add()` is the exact same
 * server that boots up the polling mechanism to handle the job.
 *
 * @param config Complete task queue configuration including the `handler` logic
 * @returns A publisher instance offering `.add()`
 */
export function taskQueue<T, R>(
  config: TaskQueueConfig<T, R>,
): ITaskQueue<T, R> {
  // Pass configuration into OqronKit's central registry for boot inspection
  registerTaskQueue(config as TaskQueueConfig<any, any>);

  return {
    async add(data: T, opts?: OqronJobOptions): Promise<OqronJobData<T, R>> {
      const adapter = getTaskQueueAdapter();
      if (!adapter) {
        throw new Error(
          `[OqronKit] Could not push job to ${config.name}. ` +
            `Have you run OqronKit.init() to bind the underlying QueueAdapter?`,
        );
      }

      const job = await adapter.enqueue<T>(config.name, data, opts);
      return job as unknown as OqronJobData<T, R>;
    },
  };
}
