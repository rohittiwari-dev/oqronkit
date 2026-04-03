import { randomUUID } from "node:crypto";
import { OqronContainer } from "../engine/index.js";
import type { OqronJob } from "../engine/types/job.types.js";
import { DependencyResolver } from "../engine/utils/dependency-resolver.js";
import { registerQueue } from "./registry.js";
import type { IQueue, QueueConfig } from "./types.js";

/**
 * Enterprise Queue Factory.
 * Simple API for monolithic/server-centric applications where publisher and consumer live together.
 *
 * @example
 * ```ts
 * const emailQueue = queue<{ to: string; subject: string }, void>({
 *   name: "email-queue",
 *   handler: async (ctx) => {
 *     await sendEmail(ctx.data.to, ctx.data.subject);
 *   },
 * });
 *
 * // Later, push a job:
 * await emailQueue.add({ to: "user@example.com", subject: "Welcome!" });
 * ```
 */
export function queue<T = any, R = any>(
  config: QueueConfig<T, R>,
): IQueue<T, R> {
  registerQueue(config);

  return {
    name: config.name,
    add: async (data, opts) => {
      const di = OqronContainer.get();
      const jobId = opts?.jobId ?? randomUUID();
      const hasDeps = opts?.dependsOn && opts.dependsOn.length > 0;

      const job: OqronJob = {
        id: jobId,
        type: "task",
        queueName: config.name,
        status: hasDeps
          ? "waiting-children"
          : opts?.delay
            ? "delayed"
            : "waiting",
        data,
        opts: opts ?? {},
        attemptMade: 0,
        progressPercent: 0,
        tags: [],
        environment: di.config?.environment,
        project: di.config?.project,
        createdAt: new Date(),
        runAt: opts?.delay ? new Date(Date.now() + opts.delay) : undefined,
      };

      // 1. Storage
      await di.storage.save("jobs", jobId, job);

      // 2. Register dependencies (add childId to parent jobs)
      if (hasDeps) {
        await DependencyResolver.registerDependencies(
          di.storage,
          jobId,
          opts!.dependsOn!,
          di.lock,
        );
        // Don't publish to broker — job stays in waiting-children until parents finish
      } else {
        // 3. Transport
        await di.broker.publish(
          config.name,
          jobId,
          opts?.delay,
          opts?.priority,
        );
      }

      return job as any;
    },
  };
}
