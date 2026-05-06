import type { WorkerConfig } from "./types.js";

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
const GLOBAL_KEY = Symbol.for("oqronkit:pending_workers");
type GlobalRegistry = typeof globalThis & {
  [key: symbol]: WorkerConfig[] | undefined;
};

function _getPending(): WorkerConfig[] {
  const g = globalThis as unknown as GlobalRegistry;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = [];
  return g[GLOBAL_KEY]!;
}

/**
 * Registers a worker config for the engine to pick up.
 */
export function registerWorker(config: WorkerConfig): void {
  const pending = _getPending();
  // If a worker with this topic already exists, replace it
  const existingIndex = pending.findIndex((w) => w.topic === config.topic);
  if (existingIndex > -1) {
    pending[existingIndex] = config;
  } else {
    pending.push(config);
  }
}

/**
 * Gets all registered worker configurations.
 */
export function getRegisteredWorkers(): WorkerConfig[] {
  return _getPending();
}

/**
 * Remove a worker from the registry by topic.
 * Used by WorkerEngine.deregisterWorker() for dynamic CRUD.
 */
export function deregisterWorker(topic: string): boolean {
  const pending = _getPending();
  const idx = pending.findIndex((w) => w.topic === topic);
  if (idx > -1) {
    pending.splice(idx, 1);
    return true;
  }
  return false;
}

/**
 * Merge workspace-level tags into every registered worker config.
 * Matches the cron/schedule `registry-factory.ts` `applyGlobalTags` pattern.
 * Deduplicates via Set to prevent tag accumulation on HMR reloads.
 */
export function applyGlobalTags(tags?: string[]): void {
  if (!tags?.length) return;
  for (const w of _getPending()) {
    w.tags = [...new Set([...(w.tags ?? []), ...tags])];
  }
}
