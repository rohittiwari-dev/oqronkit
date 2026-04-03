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

      const instanceState = await di.storage.get<{enabled: boolean}>("queue_instances", config.name);
      const isInstanceEnabled = instanceState ? instanceState.enabled : true;

      // Resolve disabledBehavior: per-queue → module-level → "hold" default
      const moduleConfig = di.config?.modules?.find?.((m: any) => m.module === "queue") as any;
      const behavior = config.disabledBehavior ?? moduleConfig?.disabledBehavior ?? "hold";

      if (!isInstanceEnabled && behavior === "reject") {
         throw new Error(`Queue ${config.name} is disabled and configured to reject new jobs`);
      }

      if (!isInstanceEnabled && behavior === "skip") {
         // Silently drop
         return { id: jobId, status: "completed" } as any; // Mock response
      }

      const job: OqronJob = {
        id: jobId,
        type: "task",
        queueName: config.name,
        moduleName: config.name,
        status: !isInstanceEnabled && behavior === "hold" 
          ? "paused" 
          : hasDeps
            ? "waiting-children"
            : opts?.delay
              ? "delayed"
              : "waiting",
        data,
        opts: opts ?? {},
        attemptMade: 0,
        progressPercent: 0,
        tags: [],
        environment: di.config?.environment ?? "default",
        project: di.config?.project ?? "default",
        createdAt: new Date(),
        queuedAt: new Date(),
        triggeredBy: "api",
        correlationId: opts?.correlationId,
        maxAttempts: opts?.attempts ?? 1,
        logs: [],
        timeline: [],
        steps: [],
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
      } else if (job.status !== "paused") {
        // 3. Transport
        await di.broker.publish(
          config.name,
          jobId,
          opts?.delay,
          opts?.priority,
        );
      }

      return job as OqronJob<T, R>;
    },
  };
}
