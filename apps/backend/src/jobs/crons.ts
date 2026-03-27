import type { ICronContext } from "@chronoforge/core";
import { cron } from "@chronoforge/scheduler";

// ─── Analytics Report ─────────────────────────────────────────────────────────
export const dailyAnalyticsReport = cron(
  "daily-analytics-report",
  {
    expression: "0 8 * * *",
    timezone: "Asia/Kolkata",
    missedFirePolicy: "run-once",
    overlap: false,
    tags: ["analytics", "reporting", "daily"],
  },
  async (ctx: ICronContext) => {
    ctx.log.info("Starting daily analytics report", { firedAt: ctx.firedAt });
    ctx.progress(10);
    await new Promise((r) => setTimeout(r, 100));
    ctx.progress(50);
    ctx.log.info("Aggregation done, writing report");
    await new Promise((r) => setTimeout(r, 100));
    ctx.progress(100);
    ctx.log.info("Daily analytics report completed");
  },
);

// ─── DB Cleanup ───────────────────────────────────────────────────────────────
export const weeklyDbCleanup = cron(
  "weekly-db-cleanup",
  {
    expression: "0 2 * * 0",
    missedFirePolicy: "skip",
    overlap: false,
    tags: ["maintenance", "database", "weekly"],
  },
  async (ctx: ICronContext) => {
    ctx.log.info("Starting weekly DB cleanup");
    if (ctx.signal.aborted) {
      ctx.log.warn("Cleanup aborted before starting");
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
    ctx.log.info("DB cleanup complete");
  },
);

// ─── Health Ping ──────────────────────────────────────────────────────────────
export const healthCheckPing = cron(
  "health-check-ping",
  {
    expression: "*/5 * * * *",
    missedFirePolicy: "skip",
    overlap: true,
    tags: ["health", "monitoring"],
  },
  async (ctx: ICronContext) => {
    ctx.log.info("Health check ping", { firedAt: ctx.firedAt.toISOString() });
  },
);

export const allCrons = [
  dailyAnalyticsReport,
  weeklyDbCleanup,
  healthCheckPing,
];
