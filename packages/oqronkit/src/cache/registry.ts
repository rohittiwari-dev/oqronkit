import type { CacheEngine } from "./cache-engine.js";

const GLOBAL_KEY = Symbol.for("oqronkit:registered_caches");

type GlobalRegistry = typeof globalThis & {
  [key: symbol]: CacheEngine<any>[] | undefined;
};

function getPending(): CacheEngine<any>[] {
  const g = globalThis as unknown as GlobalRegistry;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = [];
  return g[GLOBAL_KEY]!;
}

export function registerCache(cache: CacheEngine<any>): void {
  const pending = getPending();
  const idx = pending.findIndex((candidate) => candidate.name === cache.name);
  if (idx >= 0) {
    pending[idx] = cache;
  } else {
    pending.push(cache);
  }
}

export function deregisterCache(name: string): boolean {
  const pending = getPending();
  const idx = pending.findIndex((cache) => cache.name === name);
  if (idx < 0) return false;
  pending.splice(idx, 1);
  return true;
}

export function getCache(name: string): CacheEngine<any> | undefined {
  return getPending().find((cache) => cache.name === name);
}

export function getRegisteredCaches(): CacheEngine<any>[] {
  return getPending();
}

export function resetCachesForTesting(): void {
  (globalThis as unknown as GlobalRegistry)[GLOBAL_KEY] = [];
}
