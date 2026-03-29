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
 */

import type { ICronContext } from "oqronkit";
import { cron } from "oqronkit";

// ─────────────────────────────────────────────────────────────────────────────
// 1. DAILY ANALYTICS REPORT
//    Cron expression • Progress tracking • Timeout • Hooks • Tags
// ─────────────────────────────────────────────────────────────────────────────
export const dailyAnalyticsReport = cron({
  name: "daily-analytics-report",
  expression: "0 8 * * *", // Every day at 8:00 AM
  timezone: "Asia/Kolkata",

  // If the server was down at 8 AM, run once when it restarts
  missedFire: "run-once",

  // Don't stack runs — skip if the previous day's report is still running
  overlap: "skip",

  // Kill the handler if it runs > 2 minutes
  timeout: 120_000,

  tags: ["analytics", "reporting", "daily"],

  // Keep only the last 30 successful runs, keep ALL failures for debugging
  keepHistory: 30,
  keepFailedHistory: true,

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
    // Step 1: Extract
    ctx.progress(10, "Querying raw event data from clickhouse");
    await new Promise((r) => setTimeout(r, 200));

    // Step 2: Transform
    ctx.progress(40, "Aggregating metrics by tenant");
    await new Promise((r) => setTimeout(r, 200));

    // Respect cancellation signal (e.g., during graceful shutdown)
    if (ctx.signal.aborted) {
      ctx.log.warn("Report aborted mid-flight");
      return { aborted: true };
    }

    // Step 3: Load
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
//    Cron expression • Abort-safe • History pruning • Skip overlap
// ─────────────────────────────────────────────────────────────────────────────
export const weeklyDbCleanup = cron({
  name: "weekly-db-cleanup",
  expression: "0 2 * * 0", // Every Sunday at 2 AM

  missedFire: "skip", // Don't backfill missed cleanups
  overlap: "skip",
  tags: ["maintenance", "database", "weekly"],

  // Only keep the last 10 cleanup runs, discard failed ones entirely
  keepHistory: 10,
  keepFailedHistory: false,

  handler: async (ctx: ICronContext) => {
    ctx.log.info("🗄️  Starting weekly DB maintenance");

    // Phase 1: Vacuum expired sessions
    ctx.progress(25, "Vacuuming expired sessions");
    await new Promise((r) => setTimeout(r, 100));

    // Always check signal between long operations
    if (ctx.signal.aborted) {
      ctx.log.warn("Cleanup interrupted by shutdown signal");
      return;
    }

    // Phase 2: Archive old audit logs
    ctx.progress(50, "Archiving audit logs older than 90 days");
    await new Promise((r) => setTimeout(r, 100));

    // Phase 3: Rebuild indexes
    ctx.progress(75, "Analyzing and rebuilding indexes");
    await new Promise((r) => setTimeout(r, 100));

    ctx.progress(100, "Maintenance complete");
    ctx.log.info("✅ Weekly DB cleanup completed successfully");
    return { sessionsDeleted: 1420, logsArchived: 8503, indexesRebuilt: 7 };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. HEALTH CHECK HEARTBEAT
//    `every` interval • Overlap:run (allow concurrent) • Lightweight
// ─────────────────────────────────────────────────────────────────────────────
export const healthCheckPing = cron({
  name: "health-check-ping",
  every: { seconds: 10 },

  missedFire: "skip", // Health checks are ephemeral
  overlap: "run", // Allow concurrent pings (non-blocking)
  tags: ["health", "monitoring", "infra"],

  // Don't persist any history — this is purely a telemetry emitter
  keepHistory: false,
  keepFailedHistory: 5, // But track the last 5 failures for debugging

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
// 4. INVENTORY SYNC WITH RETRIES
//    `every` interval • Exponential retry • Timeout • Error hooks
// ─────────────────────────────────────────────────────────────────────────────
export const inventorySync = cron({
  name: "inventory-sync",
  every: { minutes: 15 },

  overlap: "skip",
  timeout: 300_000, // 5 minute ceiling

  tags: ["inventory", "sync", "ecommerce"],

  // Retry up to 3 times with exponential backoff if the supplier API flakes
  retries: {
    max: 3,
    strategy: "exponential",
    baseDelay: 2000, // 2s → 4s → 8s
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
// 5. MONTHLY BILLING — CRASH-SAFE
//    Cron expression • guaranteedWorker • HeartbeatWorker • Lock TTL
//    This is the GOLD STANDARD for critical financial operations.
// ─────────────────────────────────────────────────────────────────────────────
export const billingCron = cron({
  name: "monthly-billing",
  expression: "0 0 1 * *", // Midnight on the 1st of each month

  // ── Crash Safety ──
  // If this process dies mid-billing (OOMKill, SIGKILL, power loss),
  // the HeartbeatWorker lock TTL expires, and the StallDetector on
  // a sibling node automatically reclaims and re-executes the job.
  guaranteedWorker: true,
  heartbeatMs: 5_000, // Renew lock every 5 seconds
  lockTtlMs: 20_000, // Lock expires 20 seconds after last heartbeat

  // ── Execution Policy ──
  missedFire: "run-once", // Billing must happen even if missed
  overlap: "skip", // NEVER double-bill
  maxConcurrent: 1, // Absolute single-execution guarantee

  tags: ["billing", "finance", "critical"],

  // Fixed retry — wait exactly 30 seconds then try again
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

    // Check abort signal between expensive phases
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
//    `every` interval • maxConcurrent • Progress • Tags
// ─────────────────────────────────────────────────────────────────────────────
export const emailDigest = cron({
  name: "email-digest-sender",
  expression: "0 18 * * 1-5", // Weekdays at 6 PM

  overlap: "skip",
  missedFire: "skip",

  // Allow up to 3 concurrent digest batches if they overlap
  maxConcurrent: 3,

  timeout: 600_000, // 10 minutes max

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
// 7. CACHE WARMUP — EVERY 30 SECONDS
//    `every` interval • Short-lived • overlap: run
// ─────────────────────────────────────────────────────────────────────────────
export const cacheWarmup = cron({
  name: "cache-warmup",
  every: { seconds: 30 },

  missedFire: "skip",
  overlap: "run", // These are fast — allow overlap

  tags: ["cache", "performance"],
  keepHistory: false, // Ephemeral — don't persist runs

  handler: async (ctx: ICronContext) => {
    ctx.log.debug("🔥 Warming hot cache keys");
    // Simulate refreshing top-100 product cache
    await new Promise((r) => setTimeout(r, 50));
    return { keysWarmed: 100 };
  },
});
