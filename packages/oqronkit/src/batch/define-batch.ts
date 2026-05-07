/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  OqronKit — Batch Factory (define-batch)
 *
 *  User-facing `batch<T, R>(config)` factory that:
 *  1. Registers the batch config in the global registry
 *  2. Returns an IBatch<T, R> proxy with deferred engine calls
 *
 *  The proxy methods resolve the live engine via OqronContainer at call-time,
 *  so batch definitions can be created before OqronKit.init().
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { randomUUID } from "node:crypto";
import { OqronContainer } from "../engine/container.js";
import { OqronRegistry } from "../engine/registry.js";
import type { OqronJob } from "../engine/types/job.types.js";
import { registerBatch } from "./registry.js";
import type {
  BatchBufferRecord,
  BatchConfig,
  BatchPayload,
  IBatch,
} from "./types.js";

/**
 * Define a batch accumulator.
 *
 * Items added via `.add()` are buffered until either `maxSize` items
 * accumulate or `maxWaitMs` elapses, then flushed to the handler as a group.
 *
 * @example
 * ```ts
 * const analytics = batch<AnalyticsEvent>({
 *   name: 'analytics-flush',
 *   maxSize: 500,
 *   maxWaitMs: 10_000,
 *   handler: async (ctx) => {
 *     await db.analyticsEvents.insertMany(ctx.batch)
 *   },
 * })
 *
 * // In API routes:
 * await analytics.add({ event: 'page.view', userId: 'u_1' })
 * ```
 */
export function batch<T = any, R = any>(
  config: BatchConfig<T, R>,
): IBatch<T, R> {
  // Validate required fields eagerly (fail-fast at definition time)
  if (!config.name) {
    throw new Error("[OqronKit/Batch] `name` is required.");
  }
  if (typeof config.maxSize !== "number" || config.maxSize < 1) {
    throw new Error(
      `[OqronKit/Batch] "${config.name}": maxSize must be a positive integer.`,
    );
  }
  if (typeof config.maxWaitMs !== "number" || config.maxWaitMs < 1) {
    throw new Error(
      `[OqronKit/Batch] "${config.name}": maxWaitMs must be a positive integer.`,
    );
  }
  if (typeof config.handler !== "function") {
    throw new Error(`[OqronKit/Batch] "${config.name}": handler is required.`);
  }

  // Register in global registry (engine picks up during init)
  registerBatch(config);

  // ── Deferred helpers ──────────────────────────────────────────────────

  const batchName = config.name;
  const groupByFn = config.groupBy;
  const deduplicateByFn = config.deduplicateBy;
  const persist = config.persist !== false;
  const bufferLockTtlMs = config.lockTtlMs ?? 30_000;
  const brokerName = `batch:${batchName}`;

  /**
   * In-memory buffer for persist: false mode.
   * Map<groupKey, BatchBufferRecord>
   */
  const memoryBuffers = new Map<string, BatchBufferRecord<T>>();

  /** Resolve the DI container or throw if not initialized. */
  function getDI() {
    return OqronContainer.get();
  }

  function getBatchEngine(): any | undefined {
    return OqronRegistry.getInstance().get("batch") as any;
  }

  /** Compute the group key for an item. */
  function resolveGroupKey(item: T): string {
    return groupByFn ? groupByFn(item) : "default";
  }

  /** Compute the dedup key for an item, if configured. */
  function resolveDedupKey(item: T): string | null {
    return deduplicateByFn ? deduplicateByFn(item) : null;
  }

  /** Generate the storage key for a buffer. */
  function bufferKey(groupKey: string): string {
    return `${batchName}:${groupKey}`;
  }

  function bufferLockKey(groupKey: string): string {
    return `batch:buffer:${batchName}:${groupKey}`;
  }

  async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function withBufferLock<R>(
    groupKey: string,
    fn: () => Promise<R>,
  ): Promise<R> {
    const di = getDI();
    const owner = randomUUID();
    const lockKey = bufferLockKey(groupKey);
    const deadline = Date.now() + bufferLockTtlMs;

    while (!(await di.lock.acquire(lockKey, owner, bufferLockTtlMs))) {
      if (Date.now() >= deadline) {
        throw new Error(
          `[OqronKit/Batch] "${batchName}:${groupKey}" buffer lock timed out.`,
        );
      }
      await sleep(25);
    }

    try {
      return await fn();
    } finally {
      await di.lock.release(lockKey, owner).catch(() => {});
    }
  }

  function isTerminalStatus(status: unknown): boolean {
    return (
      status === "completed" || status === "failed" || status === "cancelled"
    );
  }

  async function recoverMarkedFlush(
    key: string,
    buffer: BatchBufferRecord<T>,
  ): Promise<BatchBufferRecord<T> | null> {
    if (!buffer.flushJobId) return buffer;

    const di = getDI();
    const job = await di.storage.get<OqronJob<BatchPayload<T>>>(
      "jobs",
      buffer.flushJobId,
    );

    if (job) {
      if (!isTerminalStatus(job.status)) {
        await di.broker.publish(brokerName, buffer.flushJobId);
      }
      await di.storage.delete("batch_buffers", key);
      return null;
    }

    const recovered: BatchBufferRecord<T> = { ...buffer };
    delete recovered.flushJobId;
    delete recovered.flushingAt;
    await di.storage.save("batch_buffers", key, recovered);
    return recovered;
  }

  async function createBatchJob(
    groupKey: string,
    items: T[],
    bufferCreatedAt: number,
  ): Promise<string> {
    const di = getDI();
    const jobId = `batch:${batchName}:${groupKey}:${randomUUID()}`;
    const now = new Date();
    const payload: BatchPayload<T> = {
      items,
      groupKey: groupKey !== "default" ? groupKey : undefined,
      bufferCreatedAt,
      flushedAt: now.getTime(),
    };

    const job: OqronJob<BatchPayload<T>> = {
      id: jobId,
      type: "batch",
      queueName: brokerName,
      data: payload,
      status: "waiting",
      attemptMade: 0,
      progressPercent: 0,
      createdAt: now,
      environment: di.config?.environment ?? "development",
      project: di.config?.project ?? "default",
      tags: [...(di.config?.tags ?? []), ...(config.tags ?? [])],
      opts: {},
    };

    await di.storage.save("jobs", jobId, job);
    await di.broker.publish(brokerName, jobId);
    return jobId;
  }

  // ── Core buffer operations ────────────────────────────────────────────

  async function addToBuffer(item: T): Promise<void> {
    const gk = resolveGroupKey(item);
    const dedupKey = resolveDedupKey(item);
    const now = Date.now();

    if (persist) {
      await withBufferLock(gk, async () => {
        const di = getDI();
        const key = bufferKey(gk);
        const existing = await di.storage.get<BatchBufferRecord<T>>(
          "batch_buffers",
          key,
        );
        const recovered = existing
          ? await recoverMarkedFlush(key, existing)
          : null;

        const buffer: BatchBufferRecord<T> = recovered ?? {
          id: key,
          items: [],
          dedupeKeys: [],
          firstItemAt: now,
          lastItemAt: now,
          environment: di.config?.environment ?? "development",
          project: di.config?.project ?? "default",
        };

        // Dedup check
        if (dedupKey && buffer.dedupeKeys.includes(dedupKey)) {
          return; // Silently skip duplicate
        }

        buffer.items.push(item);
        if (dedupKey) buffer.dedupeKeys.push(dedupKey);
        buffer.lastItemAt = now;

        await di.storage.save("batch_buffers", key, buffer);
      });
    } else {
      // In-memory only
      const gkStr = gk;
      let buffer = memoryBuffers.get(gkStr);
      if (!buffer) {
        buffer = {
          id: gkStr,
          items: [],
          dedupeKeys: [],
          firstItemAt: now,
          lastItemAt: now,
          environment: "memory",
          project: "memory",
        };
        memoryBuffers.set(gkStr, buffer);
      }

      if (dedupKey && buffer.dedupeKeys.includes(dedupKey)) {
        return;
      }

      buffer.items.push(item);
      if (dedupKey) buffer.dedupeKeys.push(dedupKey);
      buffer.lastItemAt = now;
    }
  }

  async function getBufferSizeImpl(groupKey?: string): Promise<number> {
    if (persist) {
      const di = getDI();
      if (groupKey) {
        const buf = await di.storage.get<BatchBufferRecord<T>>(
          "batch_buffers",
          bufferKey(groupKey),
        );
        return buf?.items.length ?? 0;
      }
      // Sum all buffers for this batch definition
      const allBuffers = await di.storage.list<BatchBufferRecord<T>>(
        "batch_buffers",
        {},
      );
      return allBuffers
        .filter((b: any) => {
          const id = b.id ?? b._id ?? "";
          return typeof id === "string" && id.startsWith(`${batchName}:`);
        })
        .reduce((sum: number, b: any) => sum + (b.items?.length ?? 0), 0);
    }

    if (groupKey) {
      return memoryBuffers.get(groupKey)?.items.length ?? 0;
    }
    let total = 0;
    for (const [, buf] of memoryBuffers) {
      total += buf.items.length;
    }
    return total;
  }

  // ── IBatch proxy ──────────────────────────────────────────────────────

  const proxy: IBatch<T, R> = {
    get name() {
      return batchName;
    },

    async add(item: T): Promise<void> {
      await addToBuffer(item);
    },

    async addBulk(items: T[]): Promise<void> {
      for (const item of items) {
        await addToBuffer(item);
      }
    },

    async flush(groupKey?: string): Promise<void> {
      const di = getDI();
      const key = groupKey ?? "default";
      const bk = bufferKey(key);

      if (persist) {
        await withBufferLock(key, async () => {
          const buf = await di.storage.get<BatchBufferRecord<T>>(
            "batch_buffers",
            bk,
          );
          const recovered = buf ? await recoverMarkedFlush(bk, buf) : null;
          if (!recovered || recovered.items.length === 0) return;

          let finalItems = [...recovered.items];
          if (config.hooks?.beforeFlush) {
            finalItems = await config.hooks.beforeFlush(finalItems, groupKey);
          }
          if (finalItems.length === 0) {
            await di.storage.delete("batch_buffers", bk);
            return;
          }

          const jobId = `batch:${batchName}:${key}:${randomUUID()}`;
          await di.storage.save("batch_buffers", bk, {
            ...recovered,
            flushJobId: jobId,
            flushingAt: Date.now(),
          });

          const now = new Date();
          const payload: BatchPayload<T> = {
            items: finalItems,
            groupKey: key !== "default" ? key : undefined,
            bufferCreatedAt: recovered.firstItemAt,
            flushedAt: now.getTime(),
          };

          const job: OqronJob<BatchPayload<T>> = {
            id: jobId,
            type: "batch",
            queueName: brokerName,
            data: payload,
            status: "waiting",
            attemptMade: 0,
            progressPercent: 0,
            createdAt: now,
            environment: di.config?.environment ?? "development",
            project: di.config?.project ?? "default",
            tags: [...(di.config?.tags ?? []), ...(config.tags ?? [])],
            opts: {},
          };

          await di.storage.save("jobs", jobId, job);
          await di.broker.publish(brokerName, jobId);
          await di.storage.delete("batch_buffers", bk);
        });
        return;
      }

      let items: T[];
      if (!persist) {
        const buf = memoryBuffers.get(key);
        if (!buf || buf.items.length === 0) return;
        items = [...buf.items];
        memoryBuffers.delete(key);
      } else {
        return;
      }

      // Apply beforeFlush hook
      let finalItems = items;
      if (config.hooks?.beforeFlush) {
        finalItems = await config.hooks.beforeFlush(items, groupKey);
      }
      if (finalItems.length === 0) return;

      // Create batch job
      await createBatchJob(key, finalItems, Date.now());
    },

    async getBufferSize(groupKey?: string): Promise<number> {
      return getBufferSizeImpl(groupKey);
    },

    async getJob(id: string): Promise<OqronJob<BatchPayload<T>, R> | null> {
      const di = getDI();
      return di.storage.get<OqronJob<BatchPayload<T>, R>>("jobs", id);
    },

    async getJobs(filter?: {
      status?: string;
      limit?: number;
    }): Promise<OqronJob<BatchPayload<T>, R>[]> {
      const di = getDI();
      const f: Record<string, any> = {
        queueName: `batch:${batchName}`,
      };
      if (filter?.status) f.status = filter.status;
      return di.storage.list<OqronJob<BatchPayload<T>, R>>("jobs", f, {
        limit: filter?.limit,
      });
    },

    async pause(): Promise<void> {
      const engine = getBatchEngine();
      if (engine && typeof engine.pauseBatch === "function") {
        await engine.pauseBatch(batchName);
        return;
      }
      const di = getDI();
      await di.broker.pause(brokerName);
    },

    async resume(): Promise<void> {
      const engine = getBatchEngine();
      if (engine && typeof engine.resumeBatch === "function") {
        await engine.resumeBatch(batchName);
        return;
      }
      const di = getDI();
      await di.broker.resume(brokerName);
    },

    async drain(): Promise<void> {
      const engine = getBatchEngine();
      if (engine && typeof engine.drainBatch === "function") {
        await engine.drainBatch(batchName);
        return;
      }
      await proxy.pause();
    },
  };

  // Expose memory buffers on the config for engine access (internal only).
  // The config is the same object reference in the registry, so the engine
  // can read (def as any)._memoryBuffers during tick evaluation.
  (config as any)._memoryBuffers = memoryBuffers;

  return proxy;
}
