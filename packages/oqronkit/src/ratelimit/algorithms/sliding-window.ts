import type { IStorageEngine } from "../../engine/types/engine.js";
import type { AlgorithmResult, IRateLimitAlgorithm } from "../types.js";

/**
 * Sliding Window Rate Limit Algorithm
 *
 * Stores an array of timestamp entries per key. Each entry represents one
 * unit of consumption. On check, entries older than `windowMs` are pruned,
 * and new entries are added if within capacity.
 *
 * This is the highest-accuracy algorithm — it prevents boundary bursts
 * that fixed windows are vulnerable to, but has a larger memory footprint
 * for very high-throughput keys.
 */

interface WindowEntry {
  ts: number;
}

interface SlidingWindowState {
  entries: WindowEntry[];
}

const NAMESPACE = "ratelimit:sliding";

export class SlidingWindowAlgorithm implements IRateLimitAlgorithm {
  async consume(
    storage: IStorageEngine,
    storageKey: string,
    max: number,
    windowMs: number,
    cost: number,
  ): Promise<AlgorithmResult> {
    const now = Date.now();
    const cutoff = now - windowMs;

    // Load existing state
    const state = await storage.get<SlidingWindowState>(NAMESPACE, storageKey);
    let entries = state?.entries ?? [];

    // Prune expired entries
    entries = entries.filter((e) => e.ts > cutoff);

    // Check capacity
    if (entries.length + cost > max) {
      // Find the oldest entry to calculate reset time
      const oldestTs = entries.length > 0 ? entries[0].ts : now;
      const resetMs = Math.max(0, oldestTs + windowMs - now);

      return {
        allowed: false,
        current: entries.length,
        resetMs,
      };
    }

    // Consume: add `cost` new entries
    for (let i = 0; i < cost; i++) {
      entries.push({ ts: now });
    }

    // Persist
    await storage.save(NAMESPACE, storageKey, {
      entries,
      createdAt: now + windowMs, // acts as expiresAt for GC
    });

    // Reset time = oldest entry expiry
    const oldestTs = entries.length > 0 ? entries[0].ts : now;
    const resetMs = Math.max(0, oldestTs + windowMs - now);

    return {
      allowed: true,
      current: entries.length,
      resetMs,
    };
  }

  async peek(
    storage: IStorageEngine,
    storageKey: string,
    _max: number,
    windowMs: number,
  ): Promise<{ current: number; resetMs: number }> {
    const now = Date.now();
    const cutoff = now - windowMs;

    const state = await storage.get<SlidingWindowState>(NAMESPACE, storageKey);
    let entries = state?.entries ?? [];
    entries = entries.filter((e) => e.ts > cutoff);

    const oldestTs = entries.length > 0 ? entries[0].ts : now;
    const resetMs = Math.max(0, oldestTs + windowMs - now);

    return { current: entries.length, resetMs };
  }
}
