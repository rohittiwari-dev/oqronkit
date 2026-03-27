import type { ICronContext } from "@chronoforge/core";
import { cron } from "chronoforge";

// ─── Analytics Report ─────────────────────────────────────────────────────────
export const dailyAnalyticsReport = cron.create({
  name: "daily-analytics-report",
  schedule: "0 8 * * *",
  timezone: "Asia/Kolkata",
  missedFire: "run-once",
  overlap: "skip",
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

// ─── DB Cleanup ───────────────────────────────────────────────────────────────
export const weeklyDbCleanup = cron.create({
  name: "weekly-db-cleanup",
  schedule: "0 2 * * 0",
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

// ─── Health Ping ──────────────────────────────────────────────────────────────
export const healthCheckPing = cron.create({
  name: "health-check-ping",
  schedule: "*/5 * * * *",
  missedFire: "skip",
  overlap: "run",
  tags: ["health", "monitoring"],
  handler: async (ctx: ICronContext) => {
    ctx.log.trace("Health check ping", { firedAt: ctx.firedAt.toISOString() });
  },
});

// ─── Monthly Billing (User Request Pattern) ───────────────────────────────────
export const billingCron = cron.create({
  name: "monthly-billing",
  schedule: "0 0 1 * *",

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
