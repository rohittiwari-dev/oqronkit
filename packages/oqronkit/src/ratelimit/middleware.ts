import type { CheckOptions, IRateLimiter, RateLimitResult } from "./types.js";

// ── Middleware Options ──────────────────────────────────────────────────────

export interface RateLimitMiddlewareOptions<TContext = any> {
  /** The limiter instance to use */
  limiter: IRateLimiter<TContext>;

  /** Extract the rate-limit context from the request */
  contextFromRequest: (req: any) => TContext;

  /** Optional check options (cost, dryRun overrides, etc.) */
  checkOptions?: CheckOptions;

  /**
   * Custom response handler when rate limited.
   * If omitted, responds with 429 + standard headers + JSON body.
   */
  onRateLimited?: (
    req: any,
    res: any,
    result: RateLimitResult,
  ) => void | Promise<void>;
}

// ── Express Middleware ──────────────────────────────────────────────────────

/**
 * Creates Express-compatible rate limiting middleware.
 *
 * @example
 * ```typescript
 * import { rateLimit, expressMiddleware } from "oqronkit";
 *
 * const limiter = rateLimit.create({
 *   name: "api",
 *   tiers: [{ name: "ip", key: (ctx) => ctx.ip, max: 100, window: "1m" }],
 * });
 *
 * app.use(expressMiddleware({
 *   limiter,
 *   contextFromRequest: (req) => ({ ip: req.ip }),
 * }));
 * ```
 */
export function expressMiddleware<TContext>(
  opts: RateLimitMiddlewareOptions<TContext>,
): (req: any, res: any, next: any) => Promise<void> {
  return async (req: any, res: any, next: any) => {
    try {
      const ctx = opts.contextFromRequest(req);
      const result = await opts.limiter.check(ctx, opts.checkOptions);

      // Always set rate-limit headers
      const headers = result.toHeaders();
      for (const [key, value] of Object.entries(headers)) {
        res.setHeader(key, value);
      }

      if (!result.allowed) {
        if (opts.onRateLimited) {
          await opts.onRateLimited(req, res, result);
        } else {
          res.status(429).json({
            error: "Too Many Requests",
            retryAfter: result.retryAfterSecs,
            tier: result.tier,
            limit: result.limit,
            current: result.current,
          });
        }
        return;
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

// ── Hono Middleware ─────────────────────────────────────────────────────────

/**
 * Creates Hono-compatible rate limiting middleware.
 *
 * @example
 * ```typescript
 * import { Hono } from "hono";
 * import { rateLimit, honoMiddleware } from "oqronkit";
 *
 * const limiter = rateLimit.create({
 *   name: "api",
 *   tiers: [{ name: "ip", key: (ctx) => ctx.ip, max: 100, window: "1m" }],
 * });
 *
 * const app = new Hono();
 * app.use("*", honoMiddleware({
 *   limiter,
 *   contextFromRequest: (c) => ({ ip: c.req.header("x-forwarded-for") ?? "unknown" }),
 * }));
 * ```
 */
export function honoMiddleware<TContext>(
  opts: RateLimitMiddlewareOptions<TContext>,
): (c: any, next: any) => Promise<undefined | Response> {
  return async (c: any, next: any) => {
    const ctx = opts.contextFromRequest(c);
    const result = await opts.limiter.check(ctx, opts.checkOptions);

    // Always set rate-limit headers
    const headers = result.toHeaders();
    for (const [key, value] of Object.entries(headers)) {
      c.header(key, value);
    }

    if (!result.allowed) {
      if (opts.onRateLimited) {
        await opts.onRateLimited(c, c.res, result);
        return;
      }

      return c.json(
        {
          error: "Too Many Requests",
          retryAfter: result.retryAfterSecs,
          tier: result.tier,
          limit: result.limit,
          current: result.current,
        },
        429,
      );
    }

    await next();
  };
}
