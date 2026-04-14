import { randomUUID } from "node:crypto";
import { OqronContainer } from "../engine/index.js";
import type { OqronJob } from "../engine/types/job.types.js";
import { DependencyResolver } from "../engine/utils/dependency-resolver.js";
import { registerQueue } from "./registry.js";
import type { IPublisherQueue, IQueue, QueueConfig } from "./types.js";

/**
 * Enterprise Queue Factory.
 *
 * **With handler** (monolithic): publisher and consumer live in the same process.
 * **Without handler** (publisher-only): only pushes jobs; a separate `worker()` node consumes them.
 *
 * @example
 * ```ts
 * // Monolithic (with handler)
 * const emailQueue = queue<{ to: string; subject: string }, void>({
 *   name: "email-queue",
 *   handler: async (ctx) => {
 *     await sendEmail(ctx.data.to, ctx.data.subject);
 *   },
 * });
 *
 * // Publisher-only (without handler)
 * const videoQueue = queue<{ url: string }>({ name: "video-encode" });
 *
 * // Push a job (works in both modes):
 * await emailQueue.add({ to: "user@example.com", subject: "Welcome!" });
 * await videoQueue.add({ url: "https://..." });
 * ```
 */
export function queue<T = any, R = any>(
  config: QueueConfig<T, R> & { handler: (job: any) => Promise<R> },
): IQueue<T, R>;
export function queue<T = any>(
  config: Omit<QueueConfig<T>, "handler">,
): IPublisherQueue<T>;
export function queue<T = any, R = any>(
  config: QueueConfig<T, R>,
): IQueue<T, R> | IPublisherQueue<T>;
export function queue<T = any, R = any>(
  config: QueueConfig<T, R>,
): IQueue<T, R> | IPublisherQueue<T> {
  registerQueue(config);

  return {
    name: config.name,
    add: async (data, opts) => {
      const di = OqronContainer.get();
      const jobId = opts?.jobId ?? randomUUID();
      const hasDeps = opts?.dependsOn && opts.dependsOn.length > 0;

      const instanceState = await di.storage.get<{ enabled: boolean }>(
        "queue_instances",
        config.name,
      );
      const isInstanceEnabled = instanceState ? instanceState.enabled : true;

      // Resolve disabledBehavior: per-queue → module-level → "hold" default
      const moduleConfig = di.config?.modules?.find?.(
        (m: any) => m.module === "queue",
      ) as any;
      const behavior =
        config.disabledBehavior ?? moduleConfig?.disabledBehavior ?? "hold";

      if (!isInstanceEnabled && behavior === "reject") {
        throw new Error(
          `Queue ${config.name} is disabled and configured to reject new jobs`,
        );
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
        status:
          !isInstanceEnabled && behavior === "hold"
            ? "paused"
            : hasDeps
              ? "waiting-children"
              : opts?.delay
                ? "delayed"
                : "waiting",
        pausedReason:
          !isInstanceEnabled && behavior === "hold"
            ? "disabled-hold"
            : undefined,
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

      // 1.5 Handle pruning for held jobs
      if (!isInstanceEnabled && behavior === "hold") {
        const maxHeld = moduleConfig?.maxHeldJobs ?? 100;
        const heldJobs = await di.storage.list<any>(
          "jobs",
          {
            moduleName: config.name,
            status: "paused",
            pausedReason: "disabled-hold",
          },
          { limit: 100_000 },
        );

        heldJobs.sort(
          (a, b) =>
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        );

        if (heldJobs.length > maxHeld) {
          const toRemove = heldJobs.slice(0, heldJobs.length - maxHeld);
          for (const old of toRemove) {
            await di.storage.delete("jobs", old.id);
          }
        }
      }

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
