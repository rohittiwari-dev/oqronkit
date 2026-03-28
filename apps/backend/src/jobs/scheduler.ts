import { type IScheduleContext, schedule } from "chronoforge";

// ── 1. Advanced Progress & Retry Schedule ──────────────────────────────────────────
export const dataProcessingJob = schedule({
  name: "data-cruncher",
  runAt: new Date(Date.now() + 5000), // Fire in 5 seconds
  timezone: "America/Chicago",
  retries: {
    max: 3,
    strategy: "exponential",
    baseDelay: 1000,
  },
  hooks: {
    onMissedFire: async (ctx, missedAt) => {
      ctx.log("warn", "Missed fire recovered", { missedAt });
    },
  },
  async handler(ctx: IScheduleContext) {
    ctx.progress(10, "Fetching raw data from API");
    await new Promise((resolve) => setTimeout(resolve, 500));

    ctx.progress(50, "Transforming data");
    await new Promise((resolve) => setTimeout(resolve, 500));

    ctx.progress(90, "Loading data to warehouse");
    await new Promise((resolve) => setTimeout(resolve, 500));

    ctx.progress(100, "Done");
    return { rowsProcessed: 15420, success: true };
  },
});

// ── 2. Object Configuration Recurring ────────────────────────────────────────────────
export const quarterlyReview = schedule({
  name: "quarterly-review",
  recurring: {
    frequency: "monthly",
    dayOfMonth: 1,
    at: { hour: 9, minute: 0 },
    months: [1, 4, 7, 10],
  },
  timezone: "Europe/London",
  handler: async (ctx) => {
    ctx.log("info", "Starting quarterly review...");
    console.log("Running quarterly review...");
  },
});

// ── 3. RRULE Configuration Recurring ─────────────────────────────────────────────────
export const payrollRun = schedule({
  name: "payroll",
  rrule: "FREQ=MONTHLY;BYDAY=-1FR", // last Friday of every month
  handler: async (ctx) => {
    ctx.log("info", "Starting payroll run...");
    console.log("Processing payroll...");
  },
});

// ── 4. Conditional Executions ────────────────────────────────────────────────────────
export const alertCheck = schedule({
  name: "alert-check",
  every: { minutes: 5 },
  condition: async (_ctx) => {
    // Only run if conditions are met
    const queueDepth = 1500; // Simulated
    return queueDepth > 1000;
  },
  handler: async (ctx) => {
    ctx.log("warn", "Queue depth exceeded 1000! Sending alert...");
  },
});

// ── 5. Safe Dynamic Triggers (Replacing broken inline closures) ─────────────────────
export const onboardingEmailJob = schedule<{
  userId: string;
  template: string;
}>({
  name: "onboarding-email",
  every: {
    seconds: 30,
  },
  handler: async (ctx) => {
    ctx.log("info", `Sending onboarding drip email: ${ctx.payload.template}`, {
      userId: ctx.payload.userId,
    });
  },
});

export async function scheduleOnboardingDrip(userId: string) {
  // Email 1: 3 days after signup (simulated 5 seconds for testing)
  await onboardingEmailJob.schedule({
    nameSuffix: userId, // Creates job: 'onboarding-email:user123'
    runAfter: { seconds: 5 },
    payload: { userId, template: "day3-tips" },
  });

  // Email 2: 7 days after signup (simulated 10 seconds for testing)
  await onboardingEmailJob.schedule({
    nameSuffix: `${userId}-day7`,
    runAfter: { seconds: 10 },
    payload: { userId, template: "day7-checkin" },
  });
}
