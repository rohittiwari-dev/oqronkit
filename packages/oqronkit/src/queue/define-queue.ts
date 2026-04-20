import { randomUUID } from "node:crypto";
import { OqronContainer } from "../engine/index.js";
import { OqronEventBus } from "../engine/events/event-bus.js";
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

  /** Shared add logic */
  async function addOne(data: T, opts?: any): Promise<OqronJob<T, R>> {
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
      return { id: jobId, status: "completed" } as any;
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
      tags: config.tags ?? [],
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

    // 1.5 Handle pruning for held jobs (DQ1: count-based check instead of O(N) list)
    if (!isInstanceEnabled && behavior === "hold") {
      const maxHeld = moduleConfig?.maxHeldJobs ?? 100;
      const heldJobs = await di.storage.list<any>(
        "jobs",
        {
          moduleName: config.name,
          status: "paused",
          pausedReason: "disabled-hold",
        },
        { limit: maxHeld + 1 },
      );

      if (heldJobs.length > maxHeld) {
        heldJobs.sort(
          (a: any, b: any) =>
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        );
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
      // 3. Transport — apply default priority from config if not specified per-job
      const effectivePriority = opts?.priority ?? config.priority;
      await di.broker.publish(
        config.name,
        jobId,
        opts?.delay,
        effectivePriority,
      );
    }

    return job as OqronJob<T, R>;
  }

  return {
    name: config.name,
    add: addOne,

    addBulk: async (items) => {
      const results: OqronJob<T, R>[] = [];
      for (const item of items) {
        results.push(await addOne(item.data, item.opts));
      }
      return results;
    },

    getJob: async (id) => {
      const di = OqronContainer.get();
      const job = await di.storage.get<OqronJob<T, R>>("jobs", id);
      if (!job || job.queueName !== config.name) return null;
      return job;
    },

    getJobs: async (filter) => {
      const di = OqronContainer.get();
      const query: any = { queueName: config.name };
      if (filter?.status) query.status = filter.status;
      return di.storage.list<OqronJob<T, R>>(
        "jobs",
        query,
        { limit: filter?.limit ?? 100 },
      );
    },

    count: async (status) => {
      const di = OqronContainer.get();
      const query: any = { queueName: config.name };
      if (status) query.status = status;
      return di.storage.count("jobs", query);
    },

    pause: async () => {
      const di = OqronContainer.get();
      await di.storage.save("queue_instances", config.name, { enabled: false });
      OqronEventBus.emit("queue:paused", config.name);
    },

    resume: async () => {
      const di = OqronContainer.get();
      await di.storage.save("queue_instances", config.name, { enabled: true });

      // Release held jobs to broker in batches to avoid memory pressure (DQ1)
      while (true) {
        const batch = await di.storage.list<OqronJob>(
          "jobs",
          {
            queueName: config.name,
            status: "paused",
            pausedReason: "disabled-hold",
          },
          { limit: 100 },
        );
        if (batch.length === 0) break;
        for (const held of batch) {
          held.status = "waiting";
          held.pausedReason = undefined;
          await di.storage.save("jobs", held.id, held);
          await di.broker.publish(config.name, held.id);
        }
      }

      OqronEventBus.emit("queue:resumed", config.name);
    },

    isPaused: async () => {
      const di = OqronContainer.get();
      const state = await di.storage.get<{ enabled: boolean }>(
        "queue_instances",
        config.name,
      );
      return state ? !state.enabled : false;
    },

    drain: async () => {
      const di = OqronContainer.get();
      // 1. Pause to stop new claims
      await di.storage.save("queue_instances", config.name, { enabled: false });

      // 2. Poll until no active jobs remain (or timeout after 30s)
      const drainTimeout = 30_000;
      const pollInterval = 250;
      const deadline = Date.now() + drainTimeout;

      while (Date.now() < deadline) {
        const activeJobs = await di.storage.list<OqronJob>(
          "jobs",
          { queueName: config.name, status: "active" },
          { limit: 1 },
        );
        if (activeJobs.length === 0) break;
        await new Promise((r) => setTimeout(r, pollInterval));
      }

      OqronEventBus.emit("queue:drained", config.name);
    },

    obliterate: async () => {
      const di = OqronContainer.get();
      const allJobs = await di.storage.list<OqronJob>(
        "jobs",
        { queueName: config.name },
        { limit: 100_000 },
      );
      for (const j of allJobs) {
        await di.storage.delete("jobs", j.id);
        await di.broker.ack(config.name, j.id).catch(() => {});
      }
      OqronEventBus.emit("queue:obliterated", config.name, allJobs.length);
      return allJobs.length;
    },
  };
}
