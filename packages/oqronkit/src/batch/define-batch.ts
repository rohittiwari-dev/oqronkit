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

import { OqronContainer } from "../engine/container.js";
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
    throw new Error(
      `[OqronKit/Batch] "${config.name}": handler is required.`,
    );
  }

  // Register in global registry (engine picks up during init)
  registerBatch(config);

  // ── Deferred helpers ──────────────────────────────────────────────────

  const batchName = config.name;
  const groupByFn = config.groupBy;
  const deduplicateByFn = config.deduplicateBy;
  const persist = config.persist !== false;

  /**
   * In-memory buffer for persist: false mode.
   * Map<groupKey, BatchBufferRecord>
   */
  const memoryBuffers = new Map<string, BatchBufferRecord<T>>();

  /** Resolve the DI container or throw if not initialized. */
  function getDI() {
    return OqronContainer.get();
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

  // ── Core buffer operations ────────────────────────────────────────────

  async function addToBuffer(item: T): Promise<void> {
    const gk = resolveGroupKey(item);
    const dedupKey = resolveDedupKey(item);
    const now = Date.now();

    if (persist) {
      const di = getDI();
      const key = bufferKey(gk);
      const existing = await di.storage.get<BatchBufferRecord<T>>(
        "batch_buffers",
        key,
      );

      const buffer: BatchBufferRecord<T> = existing ?? {
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
      // Force-flush delegates to the engine's flush logic
      // The engine will handle this via the registry
      const di = getDI();
      const key = groupKey ?? "default";
      const bk = bufferKey(key);

      let items: T[];
      if (persist) {
        const buf = await di.storage.get<BatchBufferRecord<T>>(
          "batch_buffers",
          bk,
        );
        if (!buf || buf.items.length === 0) return;
        items = buf.items;
        await di.storage.delete("batch_buffers", bk);
      } else {
        const buf = memoryBuffers.get(key);
        if (!buf || buf.items.length === 0) return;
        items = [...buf.items];
        memoryBuffers.delete(key);
      }

      // Apply beforeFlush hook
      let finalItems = items;
      if (config.hooks?.beforeFlush) {
        finalItems = await config.hooks.beforeFlush(items, groupKey);
      }
      if (finalItems.length === 0) return;

      // Create batch job
      const jobId = `batch:${batchName}:${key}:${Date.now()}`;
      const payload: BatchPayload<T> = {
        items: finalItems,
        groupKey: groupKey ?? undefined,
        bufferCreatedAt: Date.now(),
        flushedAt: Date.now(),
      };

      const now = new Date();
      const job = {
        id: jobId,
        type: "batch" as const,
        queueName: `batch:${batchName}`,
        data: payload,
        status: "waiting" as const,
        attemptMade: 0,
        progressPercent: 0,
        createdAt: now,
        environment: di.config?.environment ?? "development",
        project: di.config?.project ?? "default",
        tags: config.tags ?? [],
        opts: {},
      };

      await di.storage.save("jobs", jobId, job);
      await di.broker.publish(`batch:${batchName}`, jobId);
    },

    async getBufferSize(groupKey?: string): Promise<number> {
      return getBufferSizeImpl(groupKey);
    },

    async getJob(
      id: string,
    ): Promise<OqronJob<BatchPayload<T>, R> | null> {
      const di = getDI();
      return di.storage.get<OqronJob<BatchPayload<T>, R>>("jobs", id);
    },

    async getJobs(
      filter?: { status?: string; limit?: number },
    ): Promise<OqronJob<BatchPayload<T>, R>[]> {
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
      const di = getDI();
      await di.broker.pause(`batch:${batchName}`);
    },

    async resume(): Promise<void> {
      const di = getDI();
      await di.broker.resume(`batch:${batchName}`);
    },

    async drain(): Promise<void> {
      await proxy.pause();
      // Engine will wait for active jobs to complete on next stop()
    },
  };

  // Expose memory buffers on the config for engine access (internal only).
  // The config is the same object reference in the registry, so the engine
  // can read (def as any)._memoryBuffers during tick evaluation.
  (config as any)._memoryBuffers = memoryBuffers;

  return proxy;
}
