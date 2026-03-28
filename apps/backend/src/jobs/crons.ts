import type { ICronContext } from "@chronoforge/core";
import { cron } from "chronoforge";

// ─── Analytics Report (expression-based) ──────────────────────────────────────
export const dailyAnalyticsReport = cron({
  name: "daily-analytics-report",
  expression: "0 8 * * *",
  timezone: "Asia/Kolkata",
  missedFire: "run-once",
  overlap: "skip",
  timeout: 120_000,
  tags: ["analytics", "reporting", "daily"],
  handler: async (ctx: ICronContext) => {
    ctx.log.info("Starting daily analytics report", { firedAt: ctx.firedAt });
    ctx.progress(10);
    await new Promise((r) => setTimeout(r, 100));
    ctx.progress(50);
    ctx.log.info("Aggregation done, writing report");
    await new Promise((r) => setTimeout(r, 100));
    ctx.progress(100);
    ctx.log.info("Daily analytics report completed");
  },
});

// ─── DB Cleanup (expression-based) ───────────────────────────────────────────
export const weeklyDbCleanup = cron({
  name: "weekly-db-cleanup",
  expression: "0 2 * * 0",
  missedFire: "skip",
  overlap: "skip",
  tags: ["maintenance", "database", "weekly"],
  handler: async (ctx: ICronContext) => {
    ctx.log.info("Starting weekly DB cleanup");
    if (ctx.signal.aborted) {
      ctx.log.warn("Cleanup aborted before starting");
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
    ctx.log.info("DB cleanup complete");
  },
});

// ─── Health Ping (expression-based) ──────────────────────────────────────────
export const healthCheckPing = cron({
  name: "health-check-ping",
  every: {
    seconds: 5,
  },
  missedFire: "skip",
  overlap: "run",
  tags: ["health", "monitoring"],
  handler: async (ctx: ICronContext) => {
    ctx.log.trace("Health check ping", { firedAt: ctx.firedAt.toISOString() });
  },
});

// ─── Inventory Sync (every-based) ────────────────────────────────────────────
export const inventorySync = cron({
  name: "inventory-sync",
  every: { minutes: 15 },
  overlap: "skip",
  timeout: 300_000,
  tags: ["inventory", "sync"],
  handler: async (ctx: ICronContext) => {
    ctx.log.info("Syncing inventory...");
    await new Promise((r) => setTimeout(r, 100));
    ctx.log.info("Inventory synced");
  },
});

// ─── Monthly Billing (expression-based, crash-safe) ──────────────────────────
export const billingCron = cron({
  name: "monthly-billing",
  expression: "0 0 1 * *",

  // ── Crash safety config
  guaranteedWorker: true,
  heartbeatMs: 5_000,
  lockTtlMs: 20_000,

  // ── Missed-fire recovery
  missedFire: "run-once",
  overlap: "skip",
  tags: ["billing", "finance"],

  handler: async (ctx: ICronContext) => {
    ctx.log.info("Running monthly billing", { schedule: ctx.scheduleName });
    await new Promise((r) => setTimeout(r, 200));
    return { billed: true };
  },

  hooks: {
    onMissedFire: async (ctx, missedAt) => {
      ctx.log.error(
        `⚠️ Billing cron missed fire at ${missedAt.toISOString()}, running now`,
      );
    },
  },
});
