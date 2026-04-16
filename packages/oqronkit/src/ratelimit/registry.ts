import type { RateLimitEngine } from "./ratelimit-engine.js";

// ── In-memory registry of all created rate limiter instances ─────────────────
// Mirrors the queue/registry.ts and worker/registry.ts pattern.

const registeredLimiters: Map<string, RateLimitEngine<any>> = new Map();

export function registerLimiter(engine: RateLimitEngine<any>): void {
  registeredLimiters.set(engine.name, engine);
}

export function getLimiter(name: string): RateLimitEngine<any> | undefined {
  return registeredLimiters.get(name);
}

export function getRegisteredLimiters(): RateLimitEngine<any>[] {
  return [...registeredLimiters.values()];
}
