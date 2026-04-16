import { RateLimitEngine } from "./ratelimit-engine.js";
import { registerLimiter } from "./registry.js";
import type { IRateLimiter, RateLimitConfig } from "./types.js";

/**
 * Factory for creating distributed Rate Limiters.
 *
 * Every instance created via `rateLimit.create()` is automatically registered
 * in the global instance registry, making it visible to the dashboard,
 * OqronManager, and admin REST endpoints.
 *
 * @example
 * const apiLimiter = rateLimit.create({
 *   name: "api-requests",
 *   algorithm: "sliding-window",
 *   tiers: [
 *     { name: "ip", key: (ctx) => ctx.ip, max: 100, window: "1m" },
 *     { name: "user", key: (ctx) => ctx.user?.id, max: 1000, window: "1h", enabled: (ctx) => !!ctx.user }
 *   ]
 * });
 *
 * // inside an endpoint or worker handler:
 * const result = await apiLimiter.check({ ip: "1.1.1.1", user: null });
 */
export const rateLimit = {
  create<TContext = any>(
    config: RateLimitConfig<TContext>,
  ): IRateLimiter<TContext> {
    const engine = new RateLimitEngine<TContext>(config);
    registerLimiter(engine as RateLimitEngine<any>);
    return engine;
  },
};
