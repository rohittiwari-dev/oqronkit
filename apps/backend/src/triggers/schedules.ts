/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  OqronKit — Schedule Module Examples
 *  Real-world production examples showcasing EVERY feature of the schedule() API.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *  Schedule vs. Cron:
 *  • cron()      → Simple repeating jobs (expression or `every` interval).
 *  • schedule()  → Rich scheduling: runAt, runAfter, recurring, rrule, every,
 *                   typed payloads, dynamic .trigger()/.schedule(), conditions.
 *
 *  Features demonstrated:
 *  ✓ One-off execution (runAt)
 *  ✓ Delayed execution (runAt with future Date)
 *  ✓ Object-based recurring (recurring: { frequency, dayOfMonth, at, months })
 *  ✓ RFC 5545 rrule strings
 *  ✓ Simple interval (`every: { hours, minutes, seconds }`)
 *  ✓ Typed payloads with generics
 *  ✓ Dynamic .trigger() — fire immediately with payload
 *  ✓ Dynamic .schedule() — schedule future execution with payload
 *  ✓ Conditional execution (condition function)
 *  ✓ Progress tracking (percent + label)
 *  ✓ Retry strategies (exponential, fixed)
 *  ✓ Crash-safe guaranteedWorker with heartbeat
 *  ✓ Overlap and maxConcurrent protection
 *  ✓ Full lifecycle hooks (beforeRun, afterRun, onError, onMissedFire)
 *  ✓ Timeout enforcement
 *  ✓ Cancel support
 *  ✓ [NEW] Schedule versioning (version field)
 *  ✓ [NEW] Priority ordering (priority field)
 *  ✓ [NEW] Thundering herd prevention (jitterMs field)
 *  ✓ [NEW] Per-schedule rate limiting (rateLimiter field)
 */

import { type IScheduleContext, schedule } from "oqronkit";

// ─────────────────────────────────────────────────────────────────────────────
// 1. ONE-OFF EXECUTION — Data Migration
//    runAt (absolute time) • Version • Priority • Hooks
// ─────────────────────────────────────────────────────────────────────────────
export const dataMigration = schedule({
  name: "data-migration-v2",

  runAt: new Date(Date.now() + 5_000),

  timezone: "America/Chicago",

  // ── NEW: Schema version ──
  // Bump when config changes. OqronKit preserves operational state
  // (runCount, paused) but recomputes nextRunAt on version upgrade.
  version: 2,

  // ── NEW: Critical priority ──
  priority: 0,

  retries: {
    max: 3,
    strategy: "exponential",
    baseDelay: 1000,
  },
  guaranteedWorker: true,

  timeout: 120_000,

  tags: ["migration", "database", "one-off"],

  hooks: {
    beforeRun: async (ctx) => {
      ctx.log("info", "🔄 Data migration starting — creating backup...");
    },
    afterRun: async (ctx, _result) => {
      ctx.log("info", "✅ Migration completed", {
        duration: `${ctx.duration}ms`,
      });
    },
    onError: async (ctx, error) => {
      ctx.log("error", "🚨 Migration FAILED — rollback required", {
        error: error.message,
      });
    },
    onMissedFire: async (ctx, missedAt) => {
      ctx.log("warn", `Migration missed at ${missedAt.toISOString()}`);
    },
  },

  async handler(ctx: IScheduleContext) {
    ctx.progress(10, "Creating schema backup snapshot");
    await new Promise((r) => setTimeout(r, 300));

    ctx.progress(
      30,
      "Migating users table — adding 'preferences' JSONB column",
    );
    await new Promise((r) => setTimeout(r, 300));

    ctx.progress(60, "Backfilling default preferences for 54,000 rows");
    await new Promise((r) => setTimeout(r, 300));

    ctx.progress(90, "Running integrity checks");
    await new Promise((r) => setTimeout(r, 200));

    ctx.progress(100, "Done — migration v2 applied successfully");
    return { rowsMigrated: 54_000, schemaVersion: "v2.1.0" };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. RECURRING — Quarterly Financial Review
//    Object-based recurring • Conditional execution • Priority
// ─────────────────────────────────────────────────────────────────────────────
export const quarterlyReview = schedule({
  name: "quarterly-financial-review",

  recurring: {
    frequency: "monthly",
    dayOfMonth: 1,
    at: { hour: 9, minute: 0 },
    months: [1, 4, 7, 10],
  },

  timezone: "Europe/London",

  // ── NEW: High priority ──
  // Financial reports should fire before cleanup or cache jobs.
  priority: 2,

  // ── NEW: Version ──
  version: 1,

  overlap: "skip",
  missedFire: "run-once",

  tags: ["finance", "quarterly", "reporting"],

  condition: async (ctx) => {
    const day = new Date().getDay();
    const isWeekday = day > 0 && day < 6;
    if (!isWeekday) {
      ctx.log("info", "Skipping quarterly review — falls on weekend");
    }
    return isWeekday;
  },

  handler: async (ctx) => {
    ctx.log("info", "📊 Running quarterly financial review...");

    ctx.progress(25, "Pulling revenue data from Stripe");
    await new Promise((r) => setTimeout(r, 200));

    ctx.progress(50, "Calculating MRR/ARR/churn metrics");
    await new Promise((r) => setTimeout(r, 200));

    ctx.progress(75, "Generating board-ready PDF report");
    await new Promise((r) => setTimeout(r, 200));

    ctx.progress(100, "Report uploaded to Google Drive");
    return {
      quarter: "Q1-2026",
      mrr: 284_500,
      arr: 3_414_000,
      churnRate: 2.1,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. RRULE — Payroll Processing
//    RFC 5545 rrule string • Crash-safe • Rate limited • Hooks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ── NEW: Rate limiter for payroll ──
 * In a multi-node deployment, gate payroll through a rate limiter
 * to ensure only 1 fire/hour even if leader failover causes re-fires.
 */
const payrollRateLimiter = {
  async check(_ctx: { name: string }) {
    // Real: defineRateLimit({ name: "payroll", tiers: [{ name: "global", ... }] })
    return { allowed: true };
  },
};

export const payrollRun = schedule({
  name: "payroll-processing",

  // Last Friday of every month (RFC 5545 standard)
  rrule: "FREQ=MONTHLY;BYDAY=-1FR",

  // ── NEW: Rate limiter ──
  rateLimiter: payrollRateLimiter,

  // ── NEW: Highest priority + version ──
  priority: 0,
  version: 2,

  guaranteedWorker: true,
  heartbeatMs: 5_000,
  lockTtlMs: 30_000,

  overlap: "skip",
  missedFire: "run-once",

  maxConcurrent: 1,

  tags: ["payroll", "finance", "critical"],

  hooks: {
    beforeRun: async (ctx) => {
      ctx.log("info", "💰 Payroll processing beginning for all employees");
    },
    onError: async (ctx, error) => {
      ctx.log("error", "🚨 PAYROLL FAILED — HR has been notified", {
        error: error.message,
      });
    },
  },

  handler: async (ctx) => {
    ctx.progress(10, "Loading employee compensation data");
    await new Promise((r) => setTimeout(r, 100));

    ctx.progress(40, "Calculating taxes, deductions, and benefits");
    await new Promise((r) => setTimeout(r, 100));

    ctx.progress(70, "Initiating ACH transfers via banking API");
    await new Promise((r) => setTimeout(r, 100));

    ctx.progress(100, "Payroll complete — pay stubs emailed");
    return {
      employeesPaid: 324,
      totalDisbursed: 1_847_320.55,
      currency: "USD",
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. CONDITIONAL + JITTER — Alert Escalation
//    `every` interval • Condition function • Jitter • Medium priority
// ─────────────────────────────────────────────────────────────────────────────
export const alertEscalation = schedule({
  name: "alert-escalation-check",

  every: { minutes: 2 },

  // ── NEW: Jitter ──
  // Spread alert checks across a 10s window across cluster nodes.
  jitterMs: 10_000,

  // ── NEW: Medium priority ──
  priority: 10,

  overlap: "skip",
  missedFire: "skip",

  tags: ["alerts", "monitoring", "sre"],

  condition: async (ctx) => {
    const errorRate = Math.random() * 10;
    const threshold = 5.0;

    if (errorRate < threshold) {
      ctx.log(
        "info",
        `Error rate ${errorRate.toFixed(1)}% — below threshold, skipping`,
      );
      return false;
    }
    ctx.log(
      "warn",
      `Error rate ${errorRate.toFixed(1)}% — ABOVE threshold, escalating!`,
    );
    return true;
  },

  handler: async (ctx) => {
    ctx.log(
      "warn",
      "🚨 Error rate threshold breached — sending PagerDuty alert",
    );
    await new Promise((r) => setTimeout(r, 100));
    return { escalated: true, channel: "pagerduty" };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. DYNAMIC TEMPLATE — Onboarding Email Drip Campaign
//    Template pattern • Typed payload • .schedule() • .trigger()
//
//    This definition has NO timer. It only fires when you call
//    .schedule() or .trigger() with a payload from your app code.
// ─────────────────────────────────────────────────────────────────────────────
export const onboardingEmailJob = schedule<{
  userId: string;
  template: string;
  userName: string;
  email: string;
}>({
  name: "onboarding-email",

  // No `every`/`runAt`/`recurring` — this is a TEMPLATE.

  timeout: 30_000,

  retries: {
    max: 2,
    strategy: "fixed",
    baseDelay: 5000,
  },

  tags: ["email", "onboarding", "marketing"],

  hooks: {
    afterRun: async (ctx, _result) => {
      ctx.log("info", "📧 Onboarding email dispatched", {
        userId: ctx.payload.userId,
        template: ctx.payload.template,
      });
    },
    onError: async (ctx, error) => {
      ctx.log("error", "📧 Onboarding email FAILED", {
        userId: ctx.payload.userId,
        error: error.message,
      });
    },
  },

  handler: async (ctx) => {
    const { userId, template, userName, email } = ctx.payload;

    ctx.progress(20, "Loading email template");
    await new Promise((r) => setTimeout(r, 50));

    ctx.progress(60, `Rendering ${template} for ${userName}`);
    await new Promise((r) => setTimeout(r, 50));

    ctx.progress(100, "Email sent via SES");
    ctx.log("info", `✉️ Sent "${template}" email to ${email}`, { userId });

    return { sent: true, template, recipient: email };
  },
});

/**
 * Called from your API route when a new user signs up.
 * Schedules a multi-step drip campaign using the template definition above.
 */
export async function scheduleOnboardingDrip(
  userId: string,
  userName: string,
  email: string,
) {
  // Email 1: Welcome — fires immediately
  await onboardingEmailJob.trigger({
    payload: { userId, template: "welcome", userName, email },
  });

  // Email 2: Getting Started Tips — fires 3 days later (simulated: 10s)
  await onboardingEmailJob.schedule({
    nameSuffix: `${userId}-tips`,
    runAt: new Date(Date.now() + 10_000),
    payload: { userId, template: "day3-getting-started", userName, email },
  });

  // Email 3: Feature Highlight — fires 7 days later (simulated: 20s)
  await onboardingEmailJob.schedule({
    nameSuffix: `${userId}-features`,
    runAt: new Date(Date.now() + 20_000),
    payload: { userId, template: "day7-feature-highlight", userName, email },
  });

  // Email 4: Feedback Request — fires 14 days later (simulated: 30s)
  await onboardingEmailJob.schedule({
    nameSuffix: `${userId}-feedback`,
    runAt: new Date(Date.now() + 30_000),
    payload: { userId, template: "day14-feedback-request", userName, email },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. DYNAMIC TEMPLATE — Invoice Generation
//    Typed payload • Crash-safe • Rate limited • .trigger()
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ── NEW: Rate limit invoice generation ──
 * Prevent burst generation (e.g., checkout storm) from overwhelming
 * the PDF rendering pipeline.
 */
const invoiceRateLimiter = {
  async check(_ctx: { name: string }) {
    // Real: sliding-window limiter, 50 invoices per minute
    return { allowed: true };
  },
};

export const invoiceGenerationJob = schedule<{
  orderId: string;
  customerId: string;
  amount: number;
  currency: string;
}>({
  name: "invoice-generation",

  // ── NEW: Rate limiter + version ──
  rateLimiter: invoiceRateLimiter,
  version: 1,

  guaranteedWorker: true,
  heartbeatMs: 3_000,
  lockTtlMs: 15_000,

  timeout: 60_000,
  overlap: false,

  tags: ["billing", "invoices", "finance"],

  retries: {
    max: 2,
    strategy: "exponential",
    baseDelay: 3000,
  },

  handler: async (ctx) => {
    const { orderId, customerId, amount, currency } = ctx.payload;

    ctx.progress(15, "Loading order details from database");
    await new Promise((r) => setTimeout(r, 100));

    ctx.progress(40, "Calculating taxes and line items");
    await new Promise((r) => setTimeout(r, 100));

    ctx.progress(70, "Rendering PDF invoice via Puppeteer");
    await new Promise((r) => setTimeout(r, 200));

    ctx.progress(90, "Uploading PDF to S3 and emailing customer");
    await new Promise((r) => setTimeout(r, 100));

    ctx.progress(100, "Invoice delivered");
    ctx.log("info", `🧾 Invoice generated for order ${orderId}`, {
      customerId,
      amount: `${currency} ${amount}`,
    });

    return {
      invoiceId: `INV-${Date.now()}`,
      pdfUrl: `https://s3.bucket/invoices/${orderId}.pdf`,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. DELAYED EXECUTION — Trial Expiration Handler
//    runAfter • One-off with payload
// ─────────────────────────────────────────────────────────────────────────────
export const trialExpirationJob = schedule<{
  tenantId: string;
  planName: string;
  adminEmail: string;
}>({
  name: "trial-expiration",

  timeout: 30_000,
  tags: ["trials", "lifecycle", "billing"],

  handler: async (ctx) => {
    const { tenantId, planName, adminEmail } = ctx.payload;

    ctx.log("info", `⏰ Trial expired for tenant ${tenantId}`, {
      plan: planName,
    });

    ctx.progress(33, "Downgrading tenant to free tier");
    await new Promise((r) => setTimeout(r, 100));

    ctx.progress(66, `Sending expiration email to ${adminEmail}`);
    await new Promise((r) => setTimeout(r, 100));

    ctx.progress(100, "Trial expiration processed");
    return { downgraded: true, notified: true };
  },
});

/**
 * Called when a new tenant starts their trial.
 * Schedules the expiration handler for 14 days later (simulated: 15 seconds).
 */
export async function startTrial(
  tenantId: string,
  planName: string,
  adminEmail: string,
) {
  await trialExpirationJob.schedule({
    nameSuffix: tenantId,
    runAt: new Date(Date.now() + 15_000),
    payload: { tenantId, planName, adminEmail },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. EVERY INTERVAL — Metrics Aggregation Pipeline
//    `every` • Jitter • Priority • Overlap skip
// ─────────────────────────────────────────────────────────────────────────────
export const metricsAggregation = schedule({
  name: "metrics-aggregation",

  every: { minutes: 5 },

  // ── NEW: Jitter + priority ──
  jitterMs: 15_000, // Spread across 15s window in cluster
  priority: 20, // Medium priority — after billing, before cache

  overlap: "skip",
  missedFire: "skip",
  timeout: 240_000,

  tags: ["metrics", "observability", "pipeline"],

  handler: async (ctx) => {
    ctx.log("info", "📈 Starting 5-minute metrics aggregation window");

    ctx.progress(20, "Reading raw event stream from Kafka");
    await new Promise((r) => setTimeout(r, 100));

    ctx.progress(50, "Computing p50/p95/p99 latency distributions");
    await new Promise((r) => setTimeout(r, 100));

    ctx.progress(80, "Writing aggregated metrics to InfluxDB");
    await new Promise((r) => setTimeout(r, 100));

    ctx.progress(100, "Metrics aggregation window complete");
    return {
      eventsProcessed: 142_000,
      p50_ms: 12,
      p95_ms: 87,
      p99_ms: 342,
    };
  },
});
