/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  OqronKit — Backend Demo Server
 *  Showcases ALL 9 stable modules working together in a real Express.js app.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *  Active Modules:
 *  ─── Auto-discovered from triggers/ ─────────────────────────────────────────
 *  • cron         — Time-based repeating jobs          (triggers/crons.ts)
 *  • scheduler    — Rich scheduled tasks with payloads (triggers/schedules.ts)
 *  • taskQueue    — Monolithic background tasks         (triggers/task-queues.ts)
 *  • worker       — Distributed publisher/consumer      (triggers/distributed-workers.ts)
 *  • webhook      — Fan-out event distribution          (triggers/webhooks.ts)
 *  • batch        — Accumulator buffering + flush       (triggers/batches.ts)
 *  • pubsub       — Durable topics + consumer groups    (triggers/pubsub.ts)
 *
 *  ─── Standalone services (self-registering) ────────────────────────────────
 *  • rateLimit    — Multi-tier sliding window limits    (services/rate-limiters.ts)
 *  • cache        — L1/L2 tiered stampede-safe cache    (services/caches.ts)
 *
 *  Admin API:
 *  • OqronKit.expressRouter() at /api/oqron exposes 50+ built-in management
 *    endpoints for queues, jobs, schedules, batches, webhooks, caches,
 *    rate limiters, and system stats.
 */

import { mkdirSync } from "node:fs";
import express from "express";
import {
  batchModule,
  cacheModule,
  cronModule,
  OqronKit,
  pubsubModule,
  queueModule,
  rateLimitModule,
  scheduleModule,
  webhookModule,
  workerModule,
} from "oqronkit";

// ─── Import standalone services (self-register on import) ────────────────────
// These call cache.create() and rateLimit.create() which self-register
// into OqronKit's global registries immediately — no triggers dir needed.
import "./services/caches.js";
import "./services/rate-limiters.js";

// ─── Import API routes ──────────────────────────────────────────────────────
import apiRoutes from "./routes/api.routes.js";

// ─── 1. Prepare data directory ──────────────────────────────────────────────
mkdirSync("data", { recursive: true });

// ─── 2. Bootstrap OqronKit ──────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("🚀 Booting OqronKit Backend…\n");

  await OqronKit.init({
    config: {
      // ── All 9 stable modules active ──
      modules: [
        cronModule,
        scheduleModule,
        queueModule,
        workerModule,
        webhookModule,
        batchModule,
        pubsubModule,
        rateLimitModule,
        cacheModule,
      ],

      // Pretty-print structured logs for development
      logger: {
        prettify: true,
      },

      // Optional: Basic Auth for admin API
      // ui: {
      //   auth: {
      //     username: process.env.OQRON_ADMIN_USER ?? "admin",
      //     password: process.env.OQRON_ADMIN_PASS ?? "secret",
      //   },
      // },
    },
  });

  // ─── 3. Express HTTP server ────────────────────────────────────────────────
  const app = express();
  app.use(express.json());

  // Mount OqronKit built-in admin API (50+ endpoints)
  // Health, events, jobs, queues, schedules, batches, webhooks,
  // rate limiters, caches — all managed via REST.
  app.use("/api/oqron", OqronKit.expressRouter());

  // Mount business API routes (exercising all modules)
  app.use("/api", apiRoutes);

  const PORT = Number(process.env.PORT ?? 4000);
  app.listen(PORT, () => {
    console.log(`\n${"═".repeat(60)}`);
    console.log(`  OqronKit Backend Demo — http://localhost:${PORT}`);
    console.log(`${"═".repeat(60)}`);
    console.log(`\n  📊 Admin API:  http://localhost:${PORT}/api/oqron/admin/system`);
    console.log(`  💚 Health:     http://localhost:${PORT}/api/oqron/health`);
    console.log(`  📋 API Docs:   http://localhost:${PORT}/api/admin-docs`);
    console.log(`  🏠 Info:       http://localhost:${PORT}/api`);
    console.log(`\n  Modules: cron, scheduler, queue, worker, webhook,`);
    console.log(`           batch, pubsub, rateLimit, cache`);
    console.log(`\n${"═".repeat(60)}\n`);
  });
}

main().catch((err: unknown) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
