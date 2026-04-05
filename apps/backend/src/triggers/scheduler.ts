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
 *  ✓ Delayed execution (runAfter)
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
 */

import { type IScheduleContext, schedule } from "oqronkit";

// ─────────────────────────────────────────────────────────────────────────────
// 1. ONE-OFF EXECUTION — Data Migration
//    runAt (absolute time) • Progress • Exponential retry • Hooks
// ─────────────────────────────────────────────────────────────────────────────
export const dataMigration = schedule({
  name: "data-migration-v2",

  // Execute exactly 5 seconds from now (simulating a future deployment window)
  runAt: new Date(Date.now() + 5_000),

  timezone: "America/Chicago",

  retries: {
    max: 3,
    strategy: "exponential",
    baseDelay: 1000,
  },
  guaranteedWorker: true,

  timeout: 120_000, // 2 minute maximum

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
//    Object-based recurring • Timezone • Conditional execution
// ─────────────────────────────────────────────────────────────────────────────
export const quarterlyReview = schedule({
  name: "quarterly-financial-review",

  recurring: {
    frequency: "monthly",
    dayOfMonth: 1,
    at: { hour: 9, minute: 0 }, // 9:00 AM
    months: [1, 4, 7, 10], // Jan, Apr, Jul, Oct (quarterly)
  },

  timezone: "Europe/London",

  overlap: "skip",
  missedFire: "run-once",

  tags: ["finance", "quarterly", "reporting"],

  // Only run if it's a business day (skip weekends)
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
//    RFC 5545 rrule string • Crash-safe • Hooks
// ─────────────────────────────────────────────────────────────────────────────
export const payrollRun = schedule({
  name: "payroll-processing",

  // Last Friday of every month (RFC 5545 standard)
  rrule: "FREQ=MONTHLY;BYDAY=-1FR",

  // Critical financial operation — HeartbeatWorker ensures crash recoverability
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
// 4. CONDITIONAL EXECUTION — Alert Escalation
//    `every` interval • Condition function • Dynamic threshold
// ─────────────────────────────────────────────────────────────────────────────
export const alertEscalation = schedule({
  name: "alert-escalation-check",

  every: { minutes: 2 },

  overlap: "skip",
  missedFire: "skip",

  tags: ["alerts", "monitoring", "sre"],

  // Only fire if the error rate exceeds threshold
  condition: async (ctx) => {
    // Simulate checking a metrics API
    const errorRate = Math.random() * 10; // Simulated 0-10% error rate
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
  // It sits dormant until .schedule() or .trigger() is called.

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
  // Email 1: Welcome — fires 5 seconds after signup (simulated; real: 0 delay)
  await onboardingEmailJob.trigger({
    payload: { userId, template: "welcome", userName, email },
  });

  // Email 2: Getting Started Tips — fires 3 days after signup (simulated: 10s)
  await onboardingEmailJob.schedule({
    nameSuffix: `${userId}-tips`,
    runAfter: { seconds: 10 },
    payload: { userId, template: "day3-getting-started", userName, email },
  });

  // Email 3: Feature Highlight — fires 7 days after signup (simulated: 20s)
  await onboardingEmailJob.schedule({
    nameSuffix: `${userId}-features`,
    runAfter: { seconds: 20 },
    payload: { userId, template: "day7-feature-highlight", userName, email },
  });

  // Email 4: Feedback Request — fires 14 days after signup (simulated: 30s)
  await onboardingEmailJob.schedule({
    nameSuffix: `${userId}-feedback`,
    runAfter: { seconds: 30 },
    payload: { userId, template: "day14-feedback-request", userName, email },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. DYNAMIC TEMPLATE — Invoice Generation
//    Template pattern • Typed payload • Crash-safe • .trigger()
// ─────────────────────────────────────────────────────────────────────────────
export const invoiceGenerationJob = schedule<{
  orderId: string;
  customerId: string;
  amount: number;
  currency: string;
}>({
  name: "invoice-generation",

  // Crash-safe — if we die mid-PDF-generation, another node picks it up
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

  // Template — scheduled dynamically when trial starts
  timeout: 30_000,
  tags: ["trials", "lifecycle", "billing"],

  handler: async (ctx) => {
    const { tenantId, planName, adminEmail } = ctx.payload;

    ctx.log("info", `⏰ Trial expired for tenant ${tenantId}`, {
      plan: planName,
    });

    // Step 1: Downgrade to free tier
    ctx.progress(33, "Downgrading tenant to free tier");
    await new Promise((r) => setTimeout(r, 100));

    // Step 2: Send notification
    ctx.progress(66, `Sending expiration email to ${adminEmail}`);
    await new Promise((r) => setTimeout(r, 100));

    // Step 3: Schedule follow-up nudge
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
    runAfter: { seconds: 15 }, // Real: { days: 14 }
    payload: { tenantId, planName, adminEmail },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. EVERY INTERVAL — Metrics Aggregation Pipeline
//    `every` • Progress • Overlap skip
// ─────────────────────────────────────────────────────────────────────────────
export const metricsAggregation = schedule({
  name: "metrics-aggregation",

  every: { minutes: 5 },

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
