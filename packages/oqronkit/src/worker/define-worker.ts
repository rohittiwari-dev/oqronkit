import { registerWorker } from "./registry.js";
import type { IWorker, WorkerConfig } from "./types.js";

/**
 * Worker Factory (Consumer Only).
 *
 * This function defines a decoupled background worker that listens to a specific
 * topic. It does NOT have the ability to push jobs to the broker (no `.add()` method).
 * It expects a `queue()` or another publisher to push jobs to its topic.
 *
 * @example
 * ```ts
 * const videoWorker = worker<{ url: string }, void>({
 *   topic: "video-encode",
 *   concurrency: 2,
 *   handler: async (ctx) => {
 *     // Download and encode video
 *     ctx.log("info", `Processing ${ctx.data.url}`);
 *   },
 * });
 *
 * // Note: videoWorker.add() does not exist.
 * // Use a publisher queue on a different node to trigger it.
 * ```
 */
export function worker<T = any, R = any>(config: WorkerConfig<T, R>): IWorker {
  registerWorker(config);

  return {
    topic: config.topic,
  };
}
