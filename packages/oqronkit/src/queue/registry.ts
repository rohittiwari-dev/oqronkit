import type { QueueConfig } from "./types.js";

/**
 * Symbol-guarded globalThis registry.
 *
 * In monorepo setups with multiple bundler instances or duplicate `node_modules`
 * copies, module-scope arrays get duplicated — one per copy — meaning definitions
 * registered in one copy are invisible to the engine running in another.
 *
 * Using `Symbol.for()` on `globalThis` guarantees a single canonical array
 * regardless of how many copies of this file are evaluated at runtime.
 */
const GLOBAL_KEY = Symbol.for("oqronkit:pending_queues");
type GlobalRegistry = typeof globalThis & {
  [key: symbol]: QueueConfig[] | undefined;
};

function _getPending(): QueueConfig[] {
  const g = globalThis as unknown as GlobalRegistry;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = [];
  return g[GLOBAL_KEY]!;
}

export function registerQueue(config: QueueConfig): void {
  const pending = _getPending();
  // Overwrite if it exists (for HMR)
  const existing = pending.findIndex((q) => q.name === config.name);
  if (existing > -1) {
    pending[existing] = config;
  } else {
    pending.push(config);
  }
}

export function getRegisteredQueues(): QueueConfig[] {
  return _getPending();
}

/**
 * Remove a queue from the registry by name.
 * Used by QueueEngine.deregisterQueue() for dynamic CRUD.
 */
export function deregisterQueue(name: string): boolean {
  const pending = _getPending();
  const idx = pending.findIndex((q) => q.name === name);
  if (idx > -1) {
    pending.splice(idx, 1);
    return true;
  }
  return false;
}

/**
 * Merge workspace-level tags into every registered queue config.
 * Matches the cron/schedule `registry-factory.ts` `applyGlobalTags` pattern.
 * Deduplicates via Set to prevent tag accumulation on HMR reloads.
 */
export function applyGlobalTags(tags?: string[]): void {
  if (!tags?.length) return;
  for (const q of _getPending()) {
    q.tags = [...new Set([...(q.tags ?? []), ...tags])];
  }
}
