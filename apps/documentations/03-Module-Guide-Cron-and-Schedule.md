# Chapter 3: Cron & Schedule Modules

## Overview

OqronKit strictly separates **time-driven** events from **data-driven** events to prevent memory bloat and API confusion.

---

## `cron()` — The Global Process

A cron is a global background job that runs on a fixed interval or CRON expression, **regardless of user activity**. It never receives a payload from an API call.

### When to Use
- Database cleanup sweeps
- API metrics synchronization
- Nightly report generation
- Cache directory purging
- Auth token expiration checks

### API

```typescript
import { cron } from "oqronkit";

export const tokenPurger = cron({
  name: "auth-token-purger",

  // ── Timing (choose one) ─────────────────────────────────────────
  expression: "0 0 * * *",        // Standard CRON: midnight daily
  // every: { hours: 1 },         // Simple interval alternative
  // rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR",  // RRULE for complex patterns

  // ── Execution Control ───────────────────────────────────────────
  overlap: "skip",                // "skip" | "run" — what if previous run is still active?
  timeout: 3_600_000,             // Kill handler after 1 hour
  timezone: "America/New_York",   // Override global timezone

  // ── Resilience ──────────────────────────────────────────────────
  retries: { max: 2, strategy: "exponential", baseDelay: 5000 },
  missedFire: "run-once",         // "skip" | "run-once" | "run-all"

  // ── History ─────────────────────────────────────────────────────
  keepHistory: 50,                // Keep last 50 successful runs
  keepFailedHistory: 100,         // Keep last 100 failed runs

  // ── Handler ─────────────────────────────────────────────────────
  handler: async (ctx) => {
    ctx.logger.info("Starting token purge", { environment: ctx.environment });
    ctx.progress(50, "Scanning expired tokens");
    const deleted = await purgeExpiredTokens();
    return { tokensDeleted: deleted };
  },

  // ── Lifecycle Hooks ─────────────────────────────────────────────
  hooks: {
    beforeRun: async (ctx) => { /* Pre-execution setup */ },
    afterRun: async (ctx, result) => { /* Post-execution cleanup */ },
    onError: async (ctx, error) => { /* Error alerting */ },
  },
});
```

### Key Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `name` | `string` | required | Unique identifier for this cron |
| `expression` | `string` | — | Standard CRON syntax (`"*/5 * * * *"`) |
| `every` | `object` | — | Alternative: `{ hours: 1, minutes: 30 }` |
| `rrule` | `string` | — | RFC 5545 RRULE for complex patterns |
| `overlap` | `"skip" \| "run"` | `"skip"` | Behavior when previous execution is still running |
| `missedFire` | `"skip" \| "run-once" \| "run-all"` | `"run-once"` | How to handle executions missed during downtime |
| `timeout` | `number` | — | Maximum handler runtime in ms |
| `retries` | `object` | — | `{ max, strategy, baseDelay }` |
| `keepHistory` | `boolean \| number` | `true` | History retention: `true`=all, `false`=none, `50`=keep 50 |
| `keepFailedHistory` | `boolean \| number` | `true` | Same as above for failed runs |

---

## `schedule()` — The Parameterized Template

A schedule is a dynamic task tied to a specific action. You define a base template, then spawn independent instances with unique payloads and timing.

### When to Use
- Abandoned cart reminder emails (4 hours after cart created)
- Trial expiration warnings (3 days before expiry)
- SLA escalation timers
- Bi-weekly user-specific digest emails
- Any user-triggered delayed operation

### API

```typescript
import { schedule } from "oqronkit";

export const abandonedCartEmail = schedule<{ userId: string; cartId: string }>({
  name: "abandoned-cart-campaign",

  overlap: "run",       // Safe to run multiple user-specific instances
  retries: { max: 3, strategy: "exponential", baseDelay: 5000 },
  keepHistory: 30,
  keepFailedHistory: 50,

  handler: async (ctx) => {
    const { userId, cartId } = ctx.payload;
    await sendAbandonedCartEmail(userId, cartId);
    return { sent: true };
  },
});

// ── Spawning instances from your API ──────────────────────────────
app.post("/api/cart/abandoned", async (req, res) => {
  await abandonedCartEmail.schedule({
    nameSuffix: `user-${req.user.id}`,   // → "abandoned-cart-campaign:user-88"
    runAfter: { hours: 4 },              // Execute 4 hours from now
    payload: { userId: req.user.id, cartId: req.body.cartId },
  });
  res.json({ status: "scheduled" });
});

// ── Cancellation ──────────────────────────────────────────────────
app.post("/api/cart/checkout", async (req, res) => {
  await OqronKit.cancel(`abandoned-cart-campaign:user-${req.user.id}`);
  res.json({ status: "cart reminder cancelled" });
});
```

### Schedule Timing Options

| Option | Type | Description |
|--------|------|-------------|
| `runAfter` | `object` | Relative delay: `{ hours: 4 }`, `{ days: 3, hours: 12 }` |
| `runAt` | `Date` | Absolute timestamp: `new Date("2024-12-25T00:00:00Z")` |
| `every` | `object` | Recurring: `{ weeks: 2 }` for perpetual loops |
| `rrule` | `string` | Complex recurrence via RRULE |
| `payload` | `T` | Typed data unique to this instance |
| `nameSuffix` | `string` | Creates a unique DB identity for this instance |

---

## Cron vs Schedule: Quick Decision Guide

| Question | Use `cron()` | Use `schedule()` |
|----------|:---:|:---:|
| Runs on a global clock cycle? | ✅ | ❌ |
| Needs a dynamic payload? | ❌ | ✅ |
| Triggered by a user action? | ❌ | ✅ |
| One instance across the cluster? | ✅ | ❌ |
| Many concurrent instances per user? | ❌ | ✅ |
| Cleanups, sweeps, metrics? | ✅ | ❌ |
| Delayed notifications, reminders? | ❌ | ✅ |
