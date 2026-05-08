/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  OqronKit Backend — Business API Routes
 *  Express routes that exercise EVERY stable OqronKit module.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { Router } from "express";

const router = Router();

// ─── Root Info ───────────────────────────────────────────────────────────────
router.get("/", (_req, res) => {
  res.json({
    name: "OqronKit Backend Demo",
    version: "1.0.0",
    modules: [
      "cron",
      "scheduler",
      "taskQueue",
      "worker",
      "webhook",
      "batch",
      "pubsub",
      "rateLimit",
      "cache",
    ],
    routes: {
      info: "GET  /api",
      health: "GET  /api/oqron/health",
      admin: "GET  /api/oqron/admin/system",
      docs: "GET  /api/admin-docs",
    },
    sections: {
      queues: "POST /api/images/process, /api/emails/send, /api/reports/generate",
      workers: "POST /api/videos/upload",
      schedules: "POST /api/users/signup, /api/tenants/start-trial",
      webhooks: "POST /api/webhooks/fire",
      batches: "POST /api/analytics/track, /api/logs/ingest",
      pubsub: "POST /api/orders/complete, /api/notifications/send",
      cache: "GET  /api/users/:id/profile, POST /api/config/reload",
      rateLimit: "GET  /api/ratelimit/check",
      etl: "POST /api/etl/run",
    },
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  TASK QUEUE ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

router.post("/images/process", async (req, res) => {
  try {
    const { handleImageUpload } = await import(
      "../triggers/task-queues.js"
    );
    const { imageId, sourceUrl } = req.body;
    await handleImageUpload(imageId ?? `img_${Date.now()}`, sourceUrl ?? "https://uploads.example.com/photo.jpg");
    res.status(202).json({ ok: true, message: "Image processing enqueued" });
  } catch (err: unknown) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

router.post("/emails/send", async (req, res) => {
  try {
    const { sendDelayedWelcomeEmail } = await import(
      "../triggers/task-queues.js"
    );
    const { email, name } = req.body;
    await sendDelayedWelcomeEmail(email ?? "demo@example.com", name ?? "Demo User");
    res.status(202).json({ ok: true, message: "Email enqueued" });
  } catch (err: unknown) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

router.post("/reports/generate", async (req, res) => {
  try {
    const { pdfGenerationQueue } = await import(
      "../triggers/task-queues.js"
    );
    const job = await pdfGenerationQueue.add(
      {
        reportId: req.body.reportId ?? `rpt_${Date.now()}`,
        reportType: req.body.reportType ?? "monthly",
        tenantId: req.body.tenantId ?? "tenant_demo",
        dateRange: req.body.dateRange ?? {
          from: "2026-01-01",
          to: "2026-01-31",
        },
      },
      { priority: req.body.priority ?? 5 },
    );
    res.status(202).json({ ok: true, message: "PDF report enqueued", jobId: job.id });
  } catch (err: unknown) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  DISTRIBUTED WORKER ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

router.post("/videos/upload", async (req, res) => {
  try {
    const { handleUserUpload } = await import(
      "../triggers/distributed-workers.js"
    );
    const userId = req.body.userId ?? "user_demo";
    const filePath = req.body.filePath ?? "s3://uploads/demo-video.mp4";
    const result = await handleUserUpload(userId, filePath);
    res.status(202).json({ ok: true, ...result });
  } catch (err: unknown) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  SCHEDULER ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

router.post("/users/signup", async (req, res) => {
  try {
    const { scheduleOnboardingDrip } = await import(
      "../triggers/schedules.js"
    );
    const userId = req.body.userId ?? `u_${Math.random().toString(36).slice(2, 8)}`;
    const userName = req.body.userName ?? "Demo User";
    const email = req.body.email ?? "demo@example.com";
    await scheduleOnboardingDrip(userId, userName, email);
    res.status(202).json({
      ok: true,
      message: `Onboarding drip campaign scheduled for ${userId}`,
      userId,
    });
  } catch (err: unknown) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

router.post("/tenants/start-trial", async (req, res) => {
  try {
    const { startTrial } = await import("../triggers/schedules.js");
    const tenantId = req.body.tenantId ?? `tenant_${Date.now().toString(36)}`;
    const planName = req.body.planName ?? "Pro Plan";
    const adminEmail = req.body.adminEmail ?? "admin@example.com";
    await startTrial(tenantId, planName, adminEmail);
    res.status(202).json({
      ok: true,
      message: `Trial expiration scheduled for ${tenantId}`,
      tenantId,
    });
  } catch (err: unknown) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  WEBHOOK ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

router.post("/webhooks/fire", async (req, res) => {
  try {
    const { platformWebhooks } = await import("../triggers/webhooks.js");
    const eventName = req.body.event ?? "order.payment.completed";
    const payload = req.body.payload ?? {
      orderId: `ord_${Date.now().toString(36)}`,
      amount: 99.99,
      currency: "USD",
    };
    await platformWebhooks.fire(eventName, payload);
    res.status(202).json({
      ok: true,
      message: `Webhook event "${eventName}" fired`,
    });
  } catch (err: unknown) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  BATCH ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

router.post("/analytics/track", async (req, res) => {
  try {
    const { analyticsBatch } = await import("../triggers/batches.js");
    const event = {
      eventName: req.body.eventName ?? "page.view",
      userId: req.body.userId ?? `u_${Date.now().toString(36)}`,
      properties: req.body.properties ?? { page: "/dashboard" },
      timestamp: new Date().toISOString(),
    };
    await analyticsBatch.add(event);
    const bufferSize = await analyticsBatch.getBufferSize();
    res.status(202).json({
      ok: true,
      message: "Event buffered",
      bufferSize,
    });
  } catch (err: unknown) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

router.post("/logs/ingest", async (req, res) => {
  try {
    const { logBatch } = await import("../triggers/batches.js");
    const entry = {
      service: req.body.service ?? "api-gateway",
      level: req.body.level ?? "info",
      message: req.body.message ?? "Request processed",
      metadata: req.body.metadata ?? {},
      timestamp: new Date().toISOString(),
    };
    await logBatch.add(entry);
    const bufferSize = await logBatch.getBufferSize(entry.service);
    res.status(202).json({
      ok: true,
      message: `Log buffered for service: ${entry.service}`,
      bufferSize,
    });
  } catch (err: unknown) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  PUBSUB ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

router.post("/orders/complete", async (req, res) => {
  try {
    const { orderEventsTopic } = await import("../triggers/pubsub.js");
    const orderId = req.body.orderId ?? `ord_${Date.now().toString(36)}`;
    const messageId = await orderEventsTopic.publish(
      {
        orderId,
        type: "order.paid",
        customerId: req.body.customerId ?? `cust_${Date.now().toString(36)}`,
        amount: req.body.amount ?? 149.99,
        currency: req.body.currency ?? "USD",
        timestamp: new Date().toISOString(),
      },
      {
        partitionKey: orderId,
        idempotencyKey: `payment-${orderId}`,
      },
    );
    res.status(202).json({
      ok: true,
      message: `Order event published`,
      messageId,
      orderId,
    });
  } catch (err: unknown) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

router.post("/notifications/send", async (req, res) => {
  try {
    const { notificationTopic } = await import("../triggers/pubsub.js");
    const messageId = await notificationTopic.publish(
      {
        userId: req.body.userId ?? `u_${Date.now().toString(36)}`,
        channel: req.body.channel ?? "push",
        title: req.body.title ?? "New update available",
        body: req.body.body ?? "Check out the latest features!",
        priority: req.body.priority ?? "normal",
        metadata: req.body.metadata ?? {},
      },
      {
        partitionKey: req.body.userId,
      },
    );
    res.status(202).json({
      ok: true,
      message: "Notification published",
      messageId,
    });
  } catch (err: unknown) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  CACHE ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/users/:id/profile", async (req, res) => {
  try {
    const { userProfileCache } = await import("../services/caches.js");
    const profile = await userProfileCache.getOrFetch(req.params.id);
    const stats = await userProfileCache.stats();
    res.json({
      ok: true,
      profile,
      cacheStats: {
        hits: stats.hits,
        misses: stats.misses,
        l1Hits: stats.l1Hits,
        l2Hits: stats.l2Hits,
        hitRate:
          stats.hits + stats.misses > 0
            ? `${((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(1)}%`
            : "N/A",
      },
    });
  } catch (err: unknown) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

router.post("/config/reload", async (req, res) => {
  try {
    const { configCache } = await import("../services/caches.js");
    const key = req.body.key;
    if (key) {
      await configCache.invalidate(key);
      res.json({ ok: true, message: `Config key "${key}" invalidated` });
    } else {
      const count = await configCache.invalidateAll();
      res.json({ ok: true, message: `All config cache cleared`, invalidated: count });
    }
  } catch (err: unknown) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  RATE LIMITER ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/ratelimit/check", async (req, res) => {
  try {
    const { apiRateLimiter } = await import("../services/rate-limiters.js");
    const result = await apiRateLimiter.check({
      ip: req.ip ?? "127.0.0.1",
      userId: (req.query.userId as string) ?? undefined,
      plan: (req.query.plan as "free" | "pro" | "enterprise") ?? "free",
    });

    // Set standard rate-limit headers
    const headers = result.toHeaders();
    for (const [key, value] of Object.entries(headers)) {
      res.setHeader(key, value);
    }

    if (!result.allowed) {
      res.status(429).json({
        ok: false,
        error: "Rate limit exceeded",
        tier: result.tier,
        retryAfterSecs: result.retryAfterSecs,
        breakdown: result.breakdown,
      });
      return;
    }

    res.json({
      ok: true,
      allowed: result.allowed,
      remaining: result.remaining,
      breakdown: result.breakdown,
    });
  } catch (err: unknown) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ETL PIPELINE ROUTES (DAG)
// ═══════════════════════════════════════════════════════════════════════════════

router.post("/etl/run", async (req, res) => {
  try {
    const { runETLPipeline } = await import("../triggers/task-queues.js");
    const result = await runETLPipeline({
      source: req.body.source ?? "s3://data-lake/users.csv",
      format: req.body.format ?? "csv",
      transforms: req.body.transforms ?? ["normalize-emails", "deduplicate"],
      targetTable: req.body.targetTable ?? "analytics.users",
    });
    res.status(202).json({
      ok: true,
      message: "ETL pipeline started (Extract → Transform → Load)",
      jobs: result,
    });
  } catch (err: unknown) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ADMIN DOCS — Reference card for built-in management API
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/admin-docs", (_req, res) => {
  res.json({
    ok: true,
    description:
      "All admin endpoints are served under /api/oqron via OqronKit.expressRouter()",
    endpoints: {
      core: [
        { method: "GET", path: "/api/oqron/health", description: "System health check" },
        { method: "GET", path: "/api/oqron/events", description: "Rolling event log" },
        { method: "POST", path: "/api/oqron/jobs/:id", description: "Manually trigger a schedule" },
      ],
      system: [
        { method: "GET", path: "/api/oqron/admin/system", description: "System-wide stats" },
      ],
      queues: [
        { method: "GET", path: "/api/oqron/admin/queues/:name", description: "Queue info" },
        { method: "POST", path: "/api/oqron/admin/queues/:name/pause", description: "Pause queue" },
        { method: "POST", path: "/api/oqron/admin/queues/:name/resume", description: "Resume queue" },
        { method: "POST", path: "/api/oqron/admin/queues/:name/retry-failed", description: "Retry all failed" },
      ],
      jobs: [
        { method: "GET", path: "/api/oqron/admin/jobs", description: "Query jobs" },
        { method: "GET", path: "/api/oqron/admin/jobs/:id", description: "Job detail" },
        { method: "POST", path: "/api/oqron/admin/jobs/:id/retry", description: "Retry job" },
        { method: "POST", path: "/api/oqron/admin/jobs/:id/rerun", description: "Re-run job" },
        { method: "GET", path: "/api/oqron/admin/jobs/:id/chain", description: "Retry chain" },
        { method: "DELETE", path: "/api/oqron/admin/jobs/:id", description: "Cancel job" },
      ],
      schedules: [
        { method: "GET", path: "/api/oqron/admin/schedules", description: "List schedules" },
        { method: "GET", path: "/api/oqron/admin/schedules/:name", description: "Schedule detail" },
        { method: "GET", path: "/api/oqron/admin/schedules/:name/history", description: "Execution history" },
      ],
      batches: [
        { method: "GET", path: "/api/oqron/admin/batches", description: "List batches" },
        { method: "GET", path: "/api/oqron/admin/batches/:name", description: "Batch detail" },
        { method: "POST", path: "/api/oqron/admin/batches/:name/pause", description: "Pause batch" },
        { method: "POST", path: "/api/oqron/admin/batches/:name/resume", description: "Resume batch" },
        { method: "POST", path: "/api/oqron/admin/batches/:name/flush", description: "Force flush" },
        { method: "POST", path: "/api/oqron/admin/batches/:name/drain", description: "Drain batch" },
      ],
      webhooks: [
        { method: "GET", path: "/api/oqron/admin/webhooks", description: "List dispatchers" },
        { method: "GET", path: "/api/oqron/admin/webhooks/:name", description: "Dispatcher detail" },
        { method: "GET", path: "/api/oqron/admin/webhooks/:name/deliveries", description: "Delivery history" },
        { method: "POST", path: "/api/oqron/admin/webhooks/:name/pause", description: "Pause dispatcher" },
        { method: "POST", path: "/api/oqron/admin/webhooks/:name/resume", description: "Resume dispatcher" },
        { method: "POST", path: "/api/oqron/admin/webhooks/jobs/:id/resend", description: "Resend failed" },
      ],
      rateLimiters: [
        { method: "GET", path: "/api/oqron/admin/ratelimiters", description: "List limiters" },
        { method: "GET", path: "/api/oqron/admin/ratelimiters/:name", description: "Limiter detail" },
        { method: "GET", path: "/api/oqron/admin/ratelimiters/:name/events", description: "Limiter events" },
        { method: "GET", path: "/api/oqron/admin/ratelimiters/:name/snapshot", description: "Limiter snapshot" },
        { method: "POST", path: "/api/oqron/admin/ratelimiters/:name/enable", description: "Enable limiter" },
        { method: "POST", path: "/api/oqron/admin/ratelimiters/:name/disable", description: "Disable limiter" },
        { method: "POST", path: "/api/oqron/admin/ratelimiters/:name/keys/:key/ban", description: "Ban key" },
        { method: "POST", path: "/api/oqron/admin/ratelimiters/:name/keys/:key/unban", description: "Unban key" },
      ],
      caches: [
        { method: "GET", path: "/api/oqron/admin/caches", description: "List caches" },
        { method: "GET", path: "/api/oqron/admin/caches/:name", description: "Cache detail" },
        { method: "GET", path: "/api/oqron/admin/caches/:name/stats", description: "Hit/miss stats" },
        { method: "GET", path: "/api/oqron/admin/caches/:name/snapshot", description: "L1 snapshot" },
        { method: "POST", path: "/api/oqron/admin/caches/:name/clear", description: "Clear cache" },
        { method: "POST", path: "/api/oqron/admin/caches/:name/keys/:key/invalidate", description: "Invalidate key" },
      ],
      modules: [
        { method: "POST", path: "/api/oqron/admin/modules/:name/enable", description: "Enable module" },
        { method: "POST", path: "/api/oqron/admin/modules/:name/disable", description: "Disable module" },
      ],
    },
  });
});

export default router;
