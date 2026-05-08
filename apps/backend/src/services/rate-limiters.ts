/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  OqronKit — Rate Limiter Module (Service Layer)
 *  Standalone rate limiter instances — NOT triggers. No auto-discovery needed.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *  rateLimit.create() instantly registers the limiter in OqronKit's global
 *  registry, making it visible to the admin API (/admin/ratelimiters) without
 *  needing to live in the triggers/ directory.
 *
 *  Features demonstrated:
 *  ✓ Sliding window algorithm
 *  ✓ Multi-tier limits (IP → User plans)
 *  ✓ Dynamic key extraction from request context
 *  ✓ Conditional tier activation (enabled function)
 *  ✓ Penalty escalation with threshold + auto-ban
 *  ✓ Quota warnings at usage thresholds
 *  ✓ Ban/unban/override support via admin API
 *  ✓ Dry-run mode for tuning
 *  ✓ Skip function for whitelisting
 *  ✓ result.toHeaders() for HTTP rate-limit headers
 */

import { rateLimit } from "oqronkit";

// ─────────────────────────────────────────────────────────────────────────────
// 1. API RATE LIMITER — Multi-tier sliding window
//    Protects all public API endpoints with graduated limits.
//    Tier 1: Per-IP (broad), Tier 2-4: Per-User by plan
// ─────────────────────────────────────────────────────────────────────────────
type ApiContext = {
  ip: string;
  userId?: string;
  plan?: "free" | "pro" | "enterprise";
};

export const apiRateLimiter = rateLimit.create<ApiContext>({
  name: "api-requests",
  algorithm: "sliding-window",

  tiers: [
    {
      name: "ip",
      key: (ctx) => ctx.ip,
      max: 100,
      window: "1m",
    },
    {
      name: "user-free",
      key: (ctx) => ctx.userId ?? ctx.ip,
      max: 200,
      window: "1m",
      enabled: (ctx) => ctx.plan === "free" || !ctx.plan,
    },
    {
      name: "user-pro",
      key: (ctx) => ctx.userId ?? ctx.ip,
      max: 1000,
      window: "1m",
      enabled: (ctx) => ctx.plan === "pro",
    },
    {
      name: "user-enterprise",
      key: (ctx) => ctx.userId ?? ctx.ip,
      max: 10_000,
      window: "1m",
      enabled: (ctx) => ctx.plan === "enterprise",
    },
  ],

  // Penalty escalation: auto-ban after 10 violations in 5 minutes
  penalty: {
    threshold: 10,
    penaltyWindow: "5m",
    banDuration: "15m",
    onBan: async (key, tier, violations) => {
      console.warn(
        `🚫 [rate-limit] BANNED: key=${key}, tier=${tier}, violations=${violations}`,
      );
    },
    onUnban: async (key, tier) => {
      console.log(`✅ [rate-limit] Unbanned: key=${key}, tier=${tier}`);
    },
  },

  // Quota warnings at 80% and 95% usage
  warnings: {
    thresholds: {
      0.8: (_ctx, usage) => {
        console.warn(
          `⚠️ [rate-limit] 80% quota used: ${usage.key} on tier ${usage.tier} (${usage.current}/${usage.max})`,
        );
      },
      0.95: (_ctx, usage) => {
        console.warn(
          `🔴 [rate-limit] 95% quota used: ${usage.key} on tier ${usage.tier} (${usage.current}/${usage.max})`,
        );
      },
    },
  },

  // Skip rate limiting for internal service calls
  skip: async (ctx) => {
    return ctx.ip === "127.0.0.1" || ctx.ip === "::1";
  },

  // Hook when any tier blocks a request
  onLimit: async (ctx, result) => {
    console.warn(
      `🚫 Rate limited: IP=${ctx.ip}, User=${ctx.userId ?? "anon"}, ` +
        `Tier=${result.tier}, RetryAfter=${result.retryAfterSecs}s`,
    );
    // Return custom error payload attached to result.error
    return {
      code: "RATE_LIMIT_EXCEEDED",
      message: `Too many requests. Retry after ${result.retryAfterSecs}s.`,
    };
  },

  tags: ["api", "public"],
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. UPLOAD RATE LIMITER — Fixed window for file uploads
//    Prevents abuse of upload endpoints.
//    10 uploads per minute per user, 100 per hour.
// ─────────────────────────────────────────────────────────────────────────────
type UploadContext = {
  userId: string;
  fileSize: number;
};

export const uploadRateLimiter = rateLimit.create<UploadContext>({
  name: "upload-limit",
  algorithm: "fixed-window",

  tiers: [
    {
      name: "per-minute",
      key: (ctx) => ctx.userId,
      max: 10,
      window: "1m",
    },
    {
      name: "per-hour",
      key: (ctx) => ctx.userId,
      max: 100,
      window: "1h",
    },
  ],

  // Use file size as cost — large files consume more quota
  costEstimator: (ctx) => Math.max(1, Math.ceil(ctx.fileSize / (10 * 1024 * 1024))),

  onLimit: async (ctx, result) => {
    console.warn(
      `🚫 Upload rate limited: User=${ctx.userId}, Tier=${result.tier}`,
    );
  },

  tags: ["uploads", "files"],
});
