/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  OqronKit — Enterprise Backend Demo
 *  Showcases ALL modules working together in a real Express.js application.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *  Modules active:
 *  • cron       — Time-based repeating jobs (see jobs/crons.ts)
 *  • scheduler  — Rich scheduled tasks with payloads (see jobs/scheduler.ts)
 *  • taskQueue  — Monolithic background tasks (see jobs/task-queues.ts)
 *  • worker     — Distributed publisher/consumer (see jobs/distributed-workers.ts)
 *
 *  v1 Features showcased:
 *  • DI Container (OqronContainer) — automatic adapter selection
 *  • AbortController — cancel active jobs via ctx.signal
 *  • Job Ordering — FIFO / LIFO / Priority strategies
 *  • PostgreSQL / Redis / Memory adapters
 *
 *  The OqronKit engine auto-discovers all job definitions from the `jobsDir`
 *  directory and boots them into their respective modules during init().
 */

import { mkdirSync } from "node:fs";
import express from "express";
import { OqronKit, OqronManager } from "oqronkit";

// ─── 1. Prepare data directory ───────────────────────────────────────────────
mkdirSync("data", { recursive: true });

// ─── 2. Bootstrap OqronKit ──────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("🚀 Booting OqronKit Enterprise Backend…\n");

  await OqronKit.init({
    config: {
      // All four modules active — cron, scheduler, taskQueue, worker
      modules: ["cron", "scheduler", "taskQueue", "worker"],

      // Pretty-print structured logs for development
      logger: {
        prettify: true,
      },
    },
  });

  // ── Dynamic Scheduling Demo ────────────────────────────────────────────
  // Schedule a full onboarding drip campaign for a simulated new user signup
  const { scheduleOnboardingDrip } = await import("./jobs/scheduler.js");
  const userId = `u_${Math.random().toString(36).slice(2, 8)}`;
  await scheduleOnboardingDrip(userId, "Rohit Tiwari", "rohit@example.com");
  console.log(`\n📧 Onboarding drip campaign scheduled for user: ${userId}`);

  // ── Dynamic Trial Start Demo ───────────────────────────────────────────
  // Schedule trial expiration for a simulated new tenant
  const { startTrial } = await import("./jobs/scheduler.js");
  await startTrial("tenant_acme", "Pro Plan", "admin@acme.com");
  console.log("⏰ Trial expiration scheduled for tenant: tenant_acme\n");

  // ── Task Queue Demo — Enqueue some background tasks ────────────────────
  const { handleImageUpload, sendDelayedWelcomeEmail, dispatchPaymentWebhook } =
    await import("./jobs/task-queues.js");

  await handleImageUpload("img_001", "https://uploads.example.com/photo.jpg");
  console.log("🖼️  Image processing job enqueued: img_001");

  await sendDelayedWelcomeEmail("rohit@example.com", "Rohit");
  console.log("📧 Delayed welcome email enqueued (5s delay)");

  await dispatchPaymentWebhook(
    "https://hooks.example.com/payment",
    "order_42",
    99.99,
  );
  console.log("🔔 Payment webhook enqueued: order_42");

  // ── Distributed Queue Demo — Publish jobs for worker pods ──────────────
  const { placeOrder, sendBulkNotifications, requestDataExport } = await import(
    "./jobs/distributed-workers.js"
  );

  await placeOrder(
    "order_100",
    "cust_42",
    [
      { sku: "WIDGET-A", qty: 2, price: 29.99 },
      { sku: "GADGET-B", qty: 1, price: 79.99 },
    ],
    "123 Main St, NYC",
  );
  console.log("📦 Order published to distributed queue: order_100");

  await sendBulkNotifications(
    ["u_001", "u_002", "u_003"],
    "New Feature!",
    "Check out our new dashboard analytics",
  );
  console.log("🔔 Bulk notifications published for 3 users");

  const exportId = await requestDataExport("tenant_acme", "csv", {
    dateFrom: "2026-01-01",
    dateTo: "2026-03-29",
  });
  console.log(`📤 Data export requested: ${exportId} (5s delay)\n`);

  // ─── 3. Express HTTP server ────────────────────────────────────────────
  const app = express();
  app.use(express.json());

  // Mount OqronKit monitoring routes — /health, /events, /jobs/:id/trigger, etc.
  app.use("/api/oqron", OqronKit.expressRouter());

  // Basic root info
  app.get("/", (_req, res) => {
    res.json({
      name: "OqronKit Enterprise Backend Demo",
      version: "1.0.0",
      modules: ["cron", "scheduler", "taskQueue", "worker"],
      endpoints: {
        health: "GET  /api/oqron/health",
        events: "GET  /api/oqron/events?limit=50",
        trigger: "POST /api/oqron/jobs/:id/trigger",
        metrics: "GET  /api/oqron/metrics",
      },
    });
  });

  // Example API route: place an order (publishes to distributed queue)
  app.post("/api/orders", async (req, res) => {
    try {
      const { orderId, customerId, items, shippingAddress } = req.body;
      await placeOrder(orderId, customerId, items, shippingAddress);
      res.status(202).json({ message: "Order accepted", orderId });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Example API route: trigger image processing
  app.post("/api/images/process", async (req, res) => {
    try {
      const { imageId, sourceUrl } = req.body;
      await handleImageUpload(imageId, sourceUrl);
      res.status(202).json({ message: "Image processing started", imageId });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Example API route: cancel a running job (AbortController support)
  app.delete("/api/jobs/:jobId", async (req, res) => {
    try {
      const mgr = OqronManager.from(OqronKit.getConfig());
      await mgr.cancelJob(req.params.jobId);
      res.json({ message: "Job cancelled", jobId: req.params.jobId });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  const PORT = Number(process.env.PORT ?? 4000);
  app.listen(PORT, () => {
    console.log(`\n🌐 Server ready on http://localhost:${PORT}`);
    console.log(`📊 Monitoring at http://localhost:${PORT}/api/oqron/health\n`);
  });
}

main().catch((err: unknown) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
