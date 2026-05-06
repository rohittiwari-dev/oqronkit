/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  OqronKit — Batch Registry
 *
 *  Symbol-guarded globalThis registry for batch definitions.
 *  Same pattern as queue/worker/webhook registries — ensures a single
 *  canonical list even when multiple bundler copies exist.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import type { BatchConfig } from "./types.js";

const GLOBAL_KEY = Symbol.for("oqronkit:pending_batches");
type GlobalRegistry = typeof globalThis & {
  [key: symbol]: BatchConfig[] | undefined;
};

function _getPending(): BatchConfig[] {
  const g = globalThis as unknown as GlobalRegistry;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = [];
  return g[GLOBAL_KEY]!;
}

/** Register a batch definition. Overwrites existing by name (HMR-safe). */
export function registerBatch(config: BatchConfig): void {
  const pending = _getPending();
  const existing = pending.findIndex((b) => b.name === config.name);
  if (existing > -1) {
    pending[existing] = config;
  } else {
    pending.push(config);
  }
}

/** Return all registered batch definitions. */
export function getRegisteredBatches(): BatchConfig[] {
  return _getPending();
}

/** Remove a batch definition by name. */
export function deregisterBatch(name: string): boolean {
  const pending = _getPending();
  const idx = pending.findIndex((b) => b.name === name);
  if (idx > -1) {
    pending.splice(idx, 1);
    return true;
  }
  return false;
}

/**
 * Merge workspace-level tags into every registered batch config.
 * Deduplicates via Set to prevent accumulation on HMR reloads.
 */
export function applyGlobalTags(tags?: string[]): void {
  if (!tags?.length) return;
  for (const b of _getPending()) {
    b.tags = [...new Set([...(b.tags ?? []), ...tags])];
  }
}
