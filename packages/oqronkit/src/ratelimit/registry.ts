import type { RateLimitEngine } from "./ratelimit-engine.js";

const GLOBAL_KEY = Symbol.for("oqronkit:ratelimit_registry");

type GlobalRegistry = typeof globalThis & {
  [key: symbol]: Map<string, RateLimitEngine<any>> | undefined;
};

function getRegistry(): Map<string, RateLimitEngine<any>> {
  const g = globalThis as unknown as GlobalRegistry;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new Map();
  return g[GLOBAL_KEY]!;
}

export function registerLimiter(engine: RateLimitEngine<any>): void {
  getRegistry().set(engine.name, engine);
}

export function deregisterLimiter(name: string): boolean {
  return getRegistry().delete(name);
}

export function getLimiter(name: string): RateLimitEngine<any> | undefined {
  return getRegistry().get(name);
}

export function getRegisteredLimiters(): RateLimitEngine<any>[] {
  return [...getRegistry().values()];
}
