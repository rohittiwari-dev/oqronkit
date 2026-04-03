/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  OqronKit — Task Queue Examples
 *  Real-world production examples showcasing the queue() monolithic API.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *  queue vs. Queue/Worker:
 *  • queue()   → Monolithic — publisher and consumer live in the SAME process.
 *                     Best for single-server apps, background jobs, API-triggered tasks.
 *  • Queue/Worker  → Distributed — publisher and consumer live in SEPARATE processes.
 *                     Best for microservices, horizontal scaling, dedicated worker pods.
 *
 *  Features demonstrated:
 *  ✓ Typed input/output generics
 *  ✓ .add() with delay
 *  ✓ .add() with custom jobId (idempotency key)
 *  ✓ Progress tracking
 *  ✓ Retry configuration
 *  ✓ Concurrency limits
 *  ✓ Dead Letter Queue (DLQ) hooks
 *  ✓ Success/failure hooks
 *  ✓ Crash-safe guaranteedWorker
 *  ✓ Discard (permanent fail without retry)
 *  ✓ Job ordering strategy (FIFO / LIFO / Priority)
 *  ✓ AbortController cancellation (ctx.signal)
 */

import { queue } from "oqronkit";

// ─────────────────────────────────────────────────────────────────────────────
// 1. IMAGE PROCESSING PIPELINE
//    Typed I/O • Progress • Retries • Hooks
// ─────────────────────────────────────────────────────────────────────────────
type ImageInput = {
  imageId: string;
  sourceUrl: string;
  sizes: Array<{ width: number; height: number; label: string }>;
};

type ImageOutput = {
  imageId: string;
  variants: Array<{ label: string; url: string; sizeKb: number }>;
};

export const imageProcessingQueue = queue<ImageInput, ImageOutput>({
  name: "image-processing",

  concurrency: 3, // Process up to 3 images in parallel
  guaranteedWorker: true,
  heartbeatMs: 5_000,
  lockTtlMs: 30_000,

  retries: {
    max: 2,
    strategy: "exponential",
    baseDelay: 3000,
  },

  hooks: {
    onSuccess: async (_job, result) => {
      console.log(
        `✅ Image ${result.imageId} processed — ${result.variants.length} variants created`,
      );
    },
    onFail: async (job, error) => {
      console.error(
        `❌ Image ${job.data.imageId} processing failed: ${error.message}`,
      );
    },
  },

  deadLetter: {
    enabled: true,
    onDead: async (job) => {
      console.error(
        `☠️ Image ${job.data.imageId} moved to DLQ after all retries exhausted`,
      );
      // In production: send to Slack, Sentry, or a manual review queue
    },
  },

  handler: async (ctx) => {
    const { imageId, sourceUrl, sizes } = ctx.data;

    ctx.log("info", `Processing image ${imageId} from ${sourceUrl}`);
    ctx.progress(10, "Downloading original image");
    await new Promise((r) => setTimeout(r, 100));

    const variants: ImageOutput["variants"] = [];

    for (let i = 0; i < sizes.length; i++) {
      // ✅ Check cancellation signal between each resize operation
      if (ctx.signal.aborted) {
        ctx.log("warn", `Image ${imageId} processing cancelled mid-resize`);
        return { imageId, variants }; // Return partial results
      }

      const size = sizes[i];
      const percent = 20 + Math.floor((70 * (i + 1)) / sizes.length);
      ctx.progress(
        percent,
        `Resizing to ${size.label} (${size.width}x${size.height})`,
      );
      await new Promise((r) => setTimeout(r, 50));

      variants.push({
        label: size.label,
        url: `https://cdn.example.com/images/${imageId}/${size.label}.webp`,
        sizeKb: Math.round(Math.random() * 500 + 50),
      });
    }

    ctx.progress(100, "Upload to CDN complete");
    return { imageId, variants };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. EMAIL SENDING QUEUE
//    Typed payload • Delay support • Idempotency key • DLQ
// ─────────────────────────────────────────────────────────────────────────────
type EmailInput = {
  to: string;
  subject: string;
  templateName: string;
  templateVars: Record<string, string>;
};

type EmailOutput = {
  messageId: string;
  deliveredAt: Date;
};

export const emailQueue = queue<EmailInput, EmailOutput>({
  name: "email-sender",

  concurrency: 5, // SES rate limit friendly
  guaranteedWorker: true,

  retries: {
    max: 3,
    strategy: "fixed",
    baseDelay: 10_000, // Wait 10s between retries (API cooldown)
  },

  hooks: {
    onSuccess: async (job, result) => {
      console.log(
        `📧 Email delivered to ${job.data.to} — ID: ${result.messageId}`,
      );
    },
    onFail: async (job, error) => {
      console.error(`📧 Email to ${job.data.to} failed: ${error.message}`);
    },
  },

  deadLetter: {
    enabled: true,
    onDead: async (job) => {
      console.error(
        `☠️ Email permanently failed for ${job.data.to} — logging for manual review`,
      );
    },
  },

  handler: async (ctx) => {
    const {
      to,
      subject,
      templateName: _template,
      templateVars: _tempVars,
    } = ctx.data;

    ctx.log("info", `Sending "${subject}" to ${to}`);
    ctx.progress(30, "Rendering template");
    await new Promise((r) => setTimeout(r, 50));

    ctx.progress(70, "Dispatching via SES API");
    await new Promise((r) => setTimeout(r, 100));

    ctx.progress(100, "Delivered");
    return {
      messageId: `ses-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      deliveredAt: new Date(),
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. PDF REPORT GENERATION
//    Heavy CPU task • Priority ordering • Long timeout • Discard support
//    Uses strategy: "priority" so urgent reports are processed first
// ─────────────────────────────────────────────────────────────────────────────
type PdfInput = {
  reportId: string;
  reportType: "monthly" | "quarterly" | "annual";
  tenantId: string;
  dateRange: { from: string; to: string };
};

type PdfOutput = {
  pdfUrl: string;
  pages: number;
  sizeKb: number;
};

export const pdfGenerationQueue = queue<PdfInput, PdfOutput>({
  name: "pdf-generation",

  concurrency: 1, // CPU-heavy — one at a time
  strategy: "priority", // ✅ Urgent reports (lower priority number) go first
  guaranteedWorker: true,
  heartbeatMs: 10_000,
  lockTtlMs: 60_000,

  retries: {
    max: 1,
    strategy: "fixed",
    baseDelay: 5000,
  },

  hooks: {
    onSuccess: async (_job, result) => {
      console.log(
        `📄 PDF ready: ${result.pdfUrl} (${result.pages} pages, ${result.sizeKb}KB)`,
      );
    },
  },

  handler: async (ctx) => {
    const { reportId, reportType, tenantId, dateRange } = ctx.data;

    // Validate input — discard permanently if invalid
    if (!tenantId || !dateRange.from || !dateRange.to) {
      ctx.log("error", "Invalid report parameters — discarding");
      ctx.discard(); // Marks job as permanently failed, no retries
      return { pdfUrl: "", pages: 0, sizeKb: 0 };
    }

    ctx.log("info", `Generating ${reportType} report for tenant ${tenantId}`);

    ctx.progress(10, "Querying financial data");
    await new Promise((r) => setTimeout(r, 200));
    if (ctx.signal.aborted) return { pdfUrl: "", pages: 0, sizeKb: 0 };

    ctx.progress(40, "Building charts and visualizations");
    await new Promise((r) => setTimeout(r, 200));
    if (ctx.signal.aborted) return { pdfUrl: "", pages: 0, sizeKb: 0 };

    ctx.progress(70, "Rendering PDF with Puppeteer");
    await new Promise((r) => setTimeout(r, 300));
    if (ctx.signal.aborted) return { pdfUrl: "", pages: 0, sizeKb: 0 };

    ctx.progress(90, "Uploading to S3");
    await new Promise((r) => setTimeout(r, 100));

    ctx.progress(100, "Report ready");
    return {
      pdfUrl: `https://s3.example.com/reports/${tenantId}/${reportId}.pdf`,
      pages: 24,
      sizeKb: 1840,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. WEBHOOK DELIVERY QUEUE
//    High concurrency • Short tasks • Idempotency via jobId
// ─────────────────────────────────────────────────────────────────────────────
type WebhookInput = {
  url: string;
  event: string;
  payload: Record<string, unknown>;
  secret: string;
};

type WebhookOutput = {
  statusCode: number;
  responseTimeMs: number;
};

export const webhookDeliveryQueue = queue<WebhookInput, WebhookOutput>({
  name: "webhook-delivery",

  concurrency: 10, // 10 parallel webhook dispatches
  guaranteedWorker: false, // Fast tasks, no heartbeat needed

  retries: {
    max: 5,
    strategy: "exponential",
    baseDelay: 1000, // 1s → 2s → 4s → 8s → 16s
    maxDelay: 30_000,
  },

  deadLetter: {
    enabled: true,
    onDead: async (job) => {
      console.error(
        `☠️ Webhook permanently failed — URL: ${job.data.url}, Event: ${job.data.event}`,
      );
    },
  },

  handler: async (ctx) => {
    const { url, event, payload: _payload } = ctx.data;

    ctx.log("info", `Delivering webhook: ${event} → ${url}`);
    const start = Date.now();

    // Simulate HTTP POST
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
    const statusCode = Math.random() > 0.1 ? 200 : 500; // 90% success rate

    if (statusCode >= 400) {
      throw new Error(`Webhook returned HTTP ${statusCode}`);
    }

    return {
      statusCode,
      responseTimeMs: Date.now() - start,
    };
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
//  USAGE EXAMPLES — How to enqueue tasks from your API routes
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Example: An API handler that processes an uploaded image.
 */
export async function handleImageUpload(imageId: string, sourceUrl: string) {
  await imageProcessingQueue.add(
    {
      imageId,
      sourceUrl,
      sizes: [
        { width: 1200, height: 630, label: "og" },
        { width: 400, height: 400, label: "thumb" },
        { width: 150, height: 150, label: "avatar" },
      ],
    },
    {
      // Use imageId as idempotency key — prevents duplicate processing
      jobId: `img-${imageId}`,
    },
  );
}

/**
 * Example: Send a welcome email with a 1-hour delay.
 */
export async function sendDelayedWelcomeEmail(email: string, name: string) {
  await emailQueue.add(
    {
      to: email,
      subject: `Welcome to OqronKit, ${name}!`,
      templateName: "welcome",
      templateVars: { name, loginUrl: "https://app.example.com/login" },
    },
    {
      delay: 5_000, // 5 seconds delay (real: 3600_000 for 1 hour)
      jobId: `welcome-${email}`, // Idempotent — won't send twice
    },
  );
}

/**
 * Example: Fire a webhook when a payment is received.
 */
export async function dispatchPaymentWebhook(
  webhookUrl: string,
  orderId: string,
  amount: number,
) {
  await webhookDeliveryQueue.add(
    {
      url: webhookUrl,
      event: "payment.completed",
      payload: { orderId, amount, timestamp: new Date().toISOString() },
      secret: "whsec_live_abc123",
    },
    {
      jobId: `webhook-payment-${orderId}`, // Idempotent per order
    },
  );
}
