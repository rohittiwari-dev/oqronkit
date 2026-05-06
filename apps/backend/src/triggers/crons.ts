/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  OqronKit — Cron Module Examples
 *  Real-world production examples showcasing EVERY feature of the cron() API.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *  Features demonstrated:
 *  ✓ Cron expressions (standard 5-field UNIX)
 *  ✓ `every` interval-based scheduling
 *  ✓ Missed-fire recovery policies (skip, run-once, run-all)
 *  ✓ Overlap protection (skip vs run)
 *  ✓ Timeout enforcement with AbortSignal
 *  ✓ Progress tracking (percent + label)
 *  ✓ Retry strategies (exponential, fixed)
 *  ✓ Crash-safe guaranteedWorker with heartbeat
 *  ✓ Concurrency limits (maxConcurrent)
 *  ✓ Tag-based categorization
 *  ✓ Lifecycle hooks (beforeRun, afterRun, onError, onMissedFire)
 *  ✓ History retention controls (keepHistory, keepFailedHistory)
 *  ✓ Environment/project awareness
 *  ✓ [NEW] Schedule versioning (version field)
 *  ✓ [NEW] Priority ordering (priority field)
 *  ✓ [NEW] Thundering herd prevention (jitterMs field)
 *  ✓ [NEW] Per-schedule rate limiting (rateLimiter field)
 *  ✓ [NEW] Expression validation at construction (auto — throws on bad cron)
 */

import type { ICronContext } from "oqronkit";
import { cron } from "oqronkit";

// ─────────────────────────────────────────────────────────────────────────────
// 1. DAILY ANALYTICS REPORT
//    Cron expression • Priority (P0 — runs first) • Progress • Hooks
// ─────────────────────────────────────────────────────────────────────────────
export const dailyAnalyticsReport = cron({
  name: "daily-analytics-report",
  expression: "0 8 * * *", // Every day at 8:00 AM (validated at boot!)
  timezone: "Asia/Kolkata",

  // ── NEW: Schema versioning ──
  // Bump this when you change cron config to trigger controlled migration.
  // OqronKit preserves runCount/paused state but recomputes nextRunAt.
  version: 2,

  // ── NEW: Priority ──
  // Lower number = fires first when multiple crons are due simultaneously.
  // Analytics reports should run before cache warmups.
  priority: 1,

  missedFire: "run-once",
  overlap: "skip",
  timeout: 120_000,

  tags: ["analytics", "reporting", "daily"],

  keepHistory: 30,
  keepFailedHistory: true,
  guaranteedWorker: true,

  hooks: {
    beforeRun: async (ctx) => {
      ctx.log.info("📊 Analytics report generation starting...", {
        firedAt: ctx.firedAt.toISOString(),
      });
    },
    afterRun: async (ctx, result) => {
      ctx.log.info("✅ Analytics report completed", {
        duration: `${ctx.duration}ms`,
        result: JSON.stringify(result),
      });
    },
    onError: async (ctx, error) => {
      ctx.log.error("🔥 Analytics report FAILED — Slack notification sent", {
        error: error.message,
        runId: ctx.id,
      });
    },
    onMissedFire: async (ctx, missedAt) => {
      ctx.log.warn("⏰ Analytics report missed fire recovered", {
        missedAt: missedAt.toISOString(),
      });
    },
  },

  handler: async (ctx: ICronContext) => {
    ctx.progress(10, "Querying raw event data from clickhouse");
    await new Promise((r) => setTimeout(r, 200));

    ctx.progress(40, "Aggregating metrics by tenant");
    await new Promise((r) => setTimeout(r, 200));

    if (ctx.signal.aborted) {
      ctx.log.warn("Report aborted mid-flight");
      return { aborted: true };
    }

    ctx.progress(80, "Writing to data warehouse");
    await new Promise((r) => setTimeout(r, 200));

    ctx.progress(100, "Done");
    return {
      rowsProcessed: 154_200,
      tenants: 42,
      reportUrl: "https://analytics.internal/reports/2026-03-29",
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. WEEKLY DATABASE MAINTENANCE
//    Cron expression • Low priority • Abort-safe • History pruning
// ─────────────────────────────────────────────────────────────────────────────
export const weeklyDbCleanup = cron({
  name: "weekly-db-cleanup",
  expression: "0 2 * * 0", // Every Sunday at 2 AM

  // ── NEW: Low priority ──
  // DB cleanup runs after billing/analytics if they happen to fire together.
  priority: 50,

  missedFire: "skip",
  overlap: "skip",
  tags: ["maintenance", "database", "weekly"],

  keepHistory: 10,
  keepFailedHistory: false,

  handler: async (ctx: ICronContext) => {
    ctx.log.info("🗄️  Starting weekly DB maintenance");

    ctx.progress(25, "Vacuuming expired sessions");
    await new Promise((r) => setTimeout(r, 100));

    if (ctx.signal.aborted) {
      ctx.log.warn("Cleanup interrupted by shutdown signal");
      return;
    }

    ctx.progress(50, "Archiving audit logs older than 90 days");
    await new Promise((r) => setTimeout(r, 100));

    ctx.progress(75, "Analyzing and rebuilding indexes");
    await new Promise((r) => setTimeout(r, 100));

    ctx.progress(100, "Maintenance complete");
    ctx.log.info("✅ Weekly DB cleanup completed successfully");
    return { sessionsDeleted: 1420, logsArchived: 8503, indexesRebuilt: 7 };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. HEALTH CHECK HEARTBEAT
//    `every` interval • Jitter (thundering herd prevention) • Lightweight
// ─────────────────────────────────────────────────────────────────────────────
export const healthCheckPing = cron({
  name: "health-check-ping",
  every: { seconds: 10 },

  // ── NEW: Jitter ──
  // In a cluster of 50 nodes, all health checks fire at the same instant
  // without jitter, creating a thundering herd against the health API.
  // jitterMs adds a random 0–3s offset to each nextRunAt, spreading load.
  jitterMs: 3_000,

  // ── Low priority — never block critical crons ──
  priority: 100,

  missedFire: "skip",
  overlap: "run",
  tags: ["health", "monitoring", "infra"],

  keepHistory: false,
  keepFailedHistory: 5,

  handler: async (ctx: ICronContext) => {
    const checks = {
      database: "ok",
      redis: "ok",
      externalApi: "ok",
      memoryMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      uptimeSeconds: Math.round(process.uptime()),
    };
    ctx.log.debug("💓 Health check", checks);
    return checks;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. INVENTORY SYNC — RATE LIMITED
//    `every` interval • Per-schedule rate limiting • Retry • Error hooks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ── NEW: Rate limiter integration ──
 * Compose any IRateLimiter (or any object with check() → { allowed })
 * with the scheduler. If the rate limiter says "no", the fire is skipped
 * and the pointer advances normally. If the limiter throws (Redis down),
 * the fire proceeds anyway (fail-open).
 *
 * In production, you'd use:
 *   import { defineRateLimit } from "oqronkit";
 *   const supplierApiLimiter = defineRateLimit({ ... });
 *
 * For this example, we use a simple inline mock:
 */
const supplierApiLimiter = {
  async check(_ctx: { name: string }) {
    // Real implementation: sliding window against Redis
    return { allowed: true };
  },
};

export const inventorySync = cron({
  name: "inventory-sync",
  every: { minutes: 15 },

  overlap: "skip",
  timeout: 300_000,

  // ── NEW: Per-schedule rate limiting ──
  // If the supplier API has a 100-request/hour limit, gate fires through
  // the rate limiter to prevent burning the quota with automated syncs.
  rateLimiter: supplierApiLimiter,

  // ── Jitter ──
  // Spread sync across 30s window if running on multiple worker nodes.
  jitterMs: 30_000,

  tags: ["inventory", "sync", "ecommerce"],

  retries: {
    max: 3,
    strategy: "exponential",
    baseDelay: 2000,
  },

  hooks: {
    onError: async (ctx, error) => {
      ctx.log.error("🛒 Inventory sync failed — will retry", {
        error: error.message,
        runId: ctx.id,
      });
    },
  },

  handler: async (ctx: ICronContext) => {
    ctx.log.info("📦 Syncing inventory from supplier API...");

    ctx.progress(20, "Fetching supplier catalog via REST API");
    await new Promise((r) => setTimeout(r, 100));

    ctx.progress(50, "Diffing local vs. remote SKUs");
    await new Promise((r) => setTimeout(r, 100));

    ctx.progress(80, "Applying stock level updates to 3 warehouses");
    await new Promise((r) => setTimeout(r, 100));

    ctx.progress(100, "Sync complete");
    return { skusUpdated: 347, newProducts: 12, discontinued: 5 };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. MONTHLY BILLING — CRASH-SAFE + HIGHEST PRIORITY
//    Cron expression • guaranteedWorker • HeartbeatWorker • Lock TTL
//    This is the GOLD STANDARD for critical financial operations.
// ─────────────────────────────────────────────────────────────────────────────
export const billingCron = cron({
  name: "monthly-billing",
  expression: "0 0 1 * *", // Midnight on the 1st of each month

  // ── NEW: Version — bump when changing config ──
  version: 3,

  // ── NEW: Highest priority — fires before everything else ──
  priority: 0,

  // ── Crash Safety ──
  guaranteedWorker: true,
  heartbeatMs: 5_000,
  lockTtlMs: 20_000,

  // ── Execution Policy ──
  missedFire: "run-once",
  overlap: "skip",
  maxConcurrent: 1,

  tags: ["billing", "finance", "critical"],

  retries: {
    max: 2,
    strategy: "fixed",
    baseDelay: 30_000,
  },

  hooks: {
    beforeRun: async (ctx) => {
      ctx.log.info("💰 Monthly billing cycle STARTING", {
        schedule: ctx.scheduleName,
        environment: ctx.environment,
      });
    },
    afterRun: async (ctx, result) => {
      ctx.log.info("💰 Monthly billing cycle COMPLETED", {
        duration: `${ctx.duration}ms`,
        result: JSON.stringify(result),
      });
    },
    onError: async (ctx, error) => {
      ctx.log.error("🚨 CRITICAL: Billing failed — PagerDuty alert sent", {
        error: error.message,
        runId: ctx.id,
      });
    },
    onMissedFire: async (ctx, missedAt) => {
      ctx.log.error("🚨 Billing cron missed! Recovering immediately.", {
        missedAt: missedAt.toISOString(),
      });
    },
  },

  handler: async (ctx: ICronContext) => {
    ctx.progress(5, "Loading all active subscriptions");
    await new Promise((r) => setTimeout(r, 200));

    ctx.progress(30, "Calculating prorated charges for 1,247 tenants");
    await new Promise((r) => setTimeout(r, 200));

    if (ctx.signal.aborted) {
      ctx.log.warn("Billing aborted during proration phase");
      throw new Error("Billing aborted by shutdown signal");
    }

    ctx.progress(60, "Charging payment methods via Stripe API");
    await new Promise((r) => setTimeout(r, 200));

    ctx.progress(85, "Generating and emailing PDF invoices");
    await new Promise((r) => setTimeout(r, 200));

    ctx.progress(100, "Billing cycle complete");
    return {
      totalCharged: 89_420.5,
      invoicesSent: 1247,
      failedPayments: 3,
      currency: "USD",
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. EMAIL DIGEST — CONCURRENCY LIMITED
//    Cron expression • maxConcurrent • Progress • Tags
// ─────────────────────────────────────────────────────────────────────────────
export const emailDigest = cron({
  name: "email-digest-sender",
  expression: "0 18 * * 1-5", // Weekdays at 6 PM

  overlap: "skip",
  missedFire: "skip",

  maxConcurrent: 3,
  timeout: 600_000,
  priority: 5,

  tags: ["email", "notifications", "digest"],

  handler: async (ctx: ICronContext) => {
    ctx.log.info("📧 Compiling daily email digests for active users");

    ctx.progress(10, "Querying unread notifications");
    await new Promise((r) => setTimeout(r, 100));

    ctx.progress(50, "Rendering HTML templates per user");
    await new Promise((r) => setTimeout(r, 100));

    ctx.progress(90, "Dispatching 2,340 emails via SES");
    await new Promise((r) => setTimeout(r, 100));

    ctx.progress(100, "Digest delivery complete");
    return { emailsSent: 2340, avgRenderTimeMs: 12 };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. CACHE WARMUP — EVERY 30 SECONDS + JITTER
//    `every` interval • Jitter • Low priority • overlap: run
// ─────────────────────────────────────────────────────────────────────────────
export const cacheWarmup = cron({
  name: "cache-warmup",
  every: { seconds: 30 },

  // ── NEW: Jitter + low priority ──
  jitterMs: 5_000, // Spread across 5s window
  priority: 99, // Runs last among concurrent due crons

  missedFire: "skip",
  overlap: "run",

  tags: ["cache", "performance"],
  keepHistory: false,

  handler: async (ctx: ICronContext) => {
    ctx.log.debug("🔥 Warming hot cache keys");
    await new Promise((r) => setTimeout(r, 50));
    return { keysWarmed: 100 };
  },
});
