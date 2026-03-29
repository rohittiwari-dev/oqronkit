/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  OqronKit — Distributed Queue + Worker Examples
 *  Real-world production examples showcasing decoupled Queue/Worker architecture.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *  Queue/Worker vs. taskQueue:
 *  • Queue    → Pure publisher (sender). Consumes ZERO CPU/polling.
 *                Lives in your API server pods.
 *  • Worker   → Pure consumer (processor). Polls the broker for work.
 *                Lives in dedicated worker pods, horizontally scaled.
 *
 *  This separation means your API server can push 100k jobs/sec onto the
 *  queue without any local processing overhead.
 *
 *  Features demonstrated:
 *  ✓ Queue.add() — publish jobs
 *  ✓ Queue.addBulk() — batch publish
 *  ✓ Worker — processor functions
 *  ✓ Worker hooks (onSuccess, onFail)
 *  ✓ Worker concurrency and rate limiting
 *  ✓ QueueEvents — real-time event streaming (active, progress, completed, failed)
 *  ✓ Delay support
 *  ✓ Custom jobId (idempotency)
 */

import { OqronEventBus, Queue, QueueEvents, Worker } from "oqronkit";

// ═══════════════════════════════════════════════════════════════════════════════
//  1. ORDER PROCESSING PIPELINE
//     Queue → Worker architecture with QueueEvents observability
// ═══════════════════════════════════════════════════════════════════════════════

// ── Publisher (lives in API pods) ────────────────────────────────────────────
export const orderQueue = new Queue<{
  orderId: string;
  items: Array<{ sku: string; qty: number; price: number }>;
  customerId: string;
  shippingAddress: string;
}>("order-processing", {
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
  },
});

// ── Consumer (lives in worker pods) ──────────────────────────────────────────
export const orderWorker = new Worker(
  "order-processing",
  async (job) => {
    const { orderId, items, customerId, shippingAddress } = job.data;

    console.log(`📦 Processing order ${orderId} for customer ${customerId}`);
    console.log(`   Items: ${items.length}, Ship to: ${shippingAddress}`);

    // Step 1: Validate inventory
    await new Promise((r) => setTimeout(r, 100));

    // Step 2: Charge payment
    await new Promise((r) => setTimeout(r, 100));

    // Step 3: Create shipping label
    await new Promise((r) => setTimeout(r, 100));

    const total = (
      items as unknown as Array<{ price: number; qty: number }>
    ).reduce((sum, i) => sum + i.price * i.qty, 0);
    return {
      orderId,
      status: "fulfilled",
      total,
      trackingNumber: `TRK-${Date.now()}`,
    };
  },
  {
    concurrency: 5,
    hooks: {
      onSuccess: async (job, result) => {
        console.log(
          `✅ Order ${job.data.orderId} fulfilled — tracking: ${result.trackingNumber}`,
        );
      },
      onFail: async (job, error) => {
        console.error(`❌ Order ${job.data.orderId} failed: ${error.message}`);
      },
    },
  },
);

// ── Event Stream (lives in monitoring/dashboard pods) ────────────────────────
export const orderEvents = new QueueEvents("order-processing");

// Subscribe to real-time events for the order queue
orderEvents.on("active", ({ jobId }) => {
  console.log(`🟡 Order job ${jobId} is now ACTIVE`);
});

orderEvents.on("completed", ({ jobId, returnvalue }) => {
  console.log(`🟢 Order job ${jobId} COMPLETED`, returnvalue);
});

orderEvents.on("failed", ({ jobId, failedReason }) => {
  console.error(`🔴 Order job ${jobId} FAILED: ${failedReason}`);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  2. NOTIFICATION DISPATCH
//     High-throughput queue with rate limiting
// ═══════════════════════════════════════════════════════════════════════════════

export const notificationQueue = new Queue<{
  userId: string;
  channel: "push" | "sms" | "email";
  title: string;
  body: string;
}>("notifications");

export const notificationWorker = new Worker(
  "notifications",
  async (job) => {
    const { userId, channel, title } = job.data;
    console.log(
      `🔔 Sending ${channel} notification to user ${userId}: "${title}"`,
    );
    await new Promise((r) => setTimeout(r, 30));
    return { delivered: true, channel };
  },
  {
    concurrency: 10,
    // Rate limit: max 100 notifications per 60 seconds
    limiter: {
      max: 100,
      duration: 60_000,
    },
    hooks: {
      onFail: async (job, error) => {
        console.error(
          `🔔 Notification failed for ${job.data.userId}: ${error.message}`,
        );
      },
    },
  },
);

// ═══════════════════════════════════════════════════════════════════════════════
//  3. DATA EXPORT SERVICE
//     Bulk publishing • QueueEvents progress tracking
// ═══════════════════════════════════════════════════════════════════════════════

export const exportQueue = new Queue<{
  exportId: string;
  tenantId: string;
  format: "csv" | "xlsx" | "json";
  filters: Record<string, string>;
}>("data-export");

export const exportWorker = new Worker(
  "data-export",
  async (job) => {
    const { exportId, tenantId, format, filters: _filters } = job.data;
    console.log(`📤 Exporting ${format} data for tenant ${tenantId}`);

    // Simulated multi-step export
    await new Promise((r) => setTimeout(r, 200));

    return {
      exportId,
      downloadUrl: `https://s3.example.com/exports/${tenantId}/${exportId}.${format}`,
      rowCount: 15_420,
      sizeKb: 2340,
    };
  },
  {
    concurrency: 2, // Limit to 2 concurrent exports (memory constrained)
    hooks: {
      onSuccess: async (_job, result) => {
        console.log(
          `✅ Export ${result.exportId} ready: ${result.downloadUrl}`,
        );
      },
    },
  },
);

export const exportEvents = new QueueEvents("data-export");

exportEvents.on("completed", ({ jobId, returnvalue }) => {
  console.log(`📤 Export ${jobId} completed`, returnvalue);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  4. GLOBAL EVENT BUS — Cross-cutting telemetry
//     OqronEventBus hooks for system-wide observability
// ═══════════════════════════════════════════════════════════════════════════════

// Log every job start across ALL queues
OqronEventBus.on("job:start", (queueName, jobId, module) => {
  console.log(
    `[TELEMETRY] Job started — queue: ${queueName}, id: ${jobId}, module: ${module}`,
  );
});

// Log every job failure across ALL queues
OqronEventBus.on("job:fail", (queueName, jobId, error) => {
  console.error(
    `[TELEMETRY] Job failed — queue: ${queueName}, id: ${jobId}, error: ${error.message}`,
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
//  USAGE EXAMPLES — How to publish jobs from your API routes
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Example: API route handler for placing an order.
 */
export async function placeOrder(
  orderId: string,
  customerId: string,
  items: Array<{ sku: string; qty: number; price: number }>,
  shippingAddress: string,
) {
  // This runs on the API server — zero processing overhead
  await orderQueue.add("process-order", {
    orderId,
    items,
    customerId,
    shippingAddress,
  });
}

/**
 * Example: Bulk notification blast (e.g., new feature announcement).
 */
export async function sendBulkNotifications(
  userIds: string[],
  title: string,
  body: string,
) {
  // addBulk efficiently batches multiple jobs
  await notificationQueue.addBulk(
    userIds.map((userId) => ({
      name: "notify",
      data: { userId, channel: "push" as const, title, body },
    })),
  );
}

/**
 * Example: Trigger a data export with a 30-second delay.
 */
export async function requestDataExport(
  tenantId: string,
  format: "csv" | "xlsx" | "json",
  filters: Record<string, string>,
) {
  const exportId = `exp-${Date.now()}`;
  await exportQueue.add(
    "export",
    { exportId, tenantId, format, filters },
    {
      delay: 5_000, // Wait 5 seconds before processing (real: 30_000)
      jobId: exportId, // Idempotent
    },
  );
  return exportId;
}
