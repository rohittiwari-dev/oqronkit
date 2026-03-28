# Chapter 4: Standard Practical Usage

## Example 1: The Monolithic Nightly Cron Loop (`cron()`)
**Use Case Context:** We emphatically require migrating and compiling huge caches, calculating total platform analytic statistics, and sweeping out old auth tokens exactly at UTC midnight every night. Since it's a completely data-agnostic sweep mapped across the entire database autonomously, we declare it completely `payload`-free.

```typescript
import { cron } from "oqronkit";

export const midnightCleanSweep = cron({
  name: "auth-token-purger",
  expression: "0 0 * * *",    // Exact CRON syntax mapping
  overlap: "skip",            // Never attempt parallel processing if the database is locked heavily
  timeout: 3600000,           // Maximum allowable logic runtime (1 Hour limitation).
  handler: async (ctx) => {
    ctx.logger.info("Engaging the global Auth Sweep!", { environment: ctx.environment });
    
    // Theoretical Logic Processing: await db.delete("SELECT * WHERE token < MINUS 30")
    
    return { tokens_cleared: 5690 };
  }
});
```

---

## Example 2: The E-Commerce Abandoned Cart Dispatch (`schedule()` Delayed Logic)
**Use Case Context:** A specific user logs into your portal, adds a 4K Monitor, and abruptly exits. Since we know definitively the exact dynamic target User ID statically, we don't boot an ugly massive sweeping cron task! Instead, we generate an absolute delayed function instance natively targeted specifically to ping them after exactly 4 Hours!

```typescript
import { schedule } from "oqronkit";
import { OqronKit } from "oqronkit";

// 1. Defining the Dormant Blueprint Structure:
export const abandonedCartEmailTemplate = schedule<{ userId: string, product: string }>({
  name: "abandoned-cart-campaign",
  overlap: "run", // It's extremely safe to parallel-process thousands of unique payloads concurrently.
  retries: { maxAttempts: 5, backoffFactor: 2 }, // Extensively mitigates AWS SES Email rate limits
  handler: async (ctx) => {
    const { userId, product } = ctx.payload;
    await sendPromotionalReminder(userId, product);
  }
});

// 2. The Dynamic Payload Injection Route (Express POST Handler):
app.post("/api/checkout/cart-updated", async (req, res) => {
  const user = req.user;
  const productTitle = req.body.title;

  // We explicitly schedule an instance exclusively for User #88 in the Database natively:
  await abandonedCartEmailTemplate.schedule({
    nameSuffix: `user-${user.id}`, // Generates Identity row: "abandoned-cart-campaign:user-88"
    runAfter: { hours: 4 },        // Delays processing exactly 4 hours from Date.Now()
    payload: { userId: user.id, product: productTitle }
  });

  return res.json({ status: "Cart Saved!" });
});

// 3. User Checked out successfully in Hour 2? Cleanly intercept the logic:
app.post("/api/checkout/completed", async (req, res) => {
  // Gracefully locate the exact OqronKit execution string natively and purge the logic safely
  await OqronKit.cancel(`abandoned-cart-campaign:user-${req.user.id}`);
});
```

---

## Example 3: The Dashboard 'Dynamic Bi-Weekly Report Toggle' (Infinite User Loops)
**Use Case Context:** Inside a Vue/React generic settings dashboard, the user actively engages a visual Switch declaring *"Email me a financial breakdown explicitly every 14 days."*

```typescript
// 1. Establish the "Base Template"
export const financialDigestTemplate = schedule<{ userId: string }>({
  name: "bi-weekly-finance-digest",
  overlap: "skip",
  handler: async (ctx) => { 
    // Aggregate DB transactions
    await generateFinancePDF(ctx.payload.userId); 
  }
});

// 2. Establish the Infinite Database Trigger!
app.post("/api/settings/toggle-digest", async (req, res) => {
  const { isEnabled, userId } = req.body;
  
  if (isEnabled) {
    // Injecting `every` directly into `.schedule` establishes a perpetual infinite loop natively purely for this user ID!
    await financialDigestTemplate.schedule({
      nameSuffix: userId,
      every: { weeks: 2 },                // <-- The Recurrance Execution Engine binding occurs!
      payload: { userId }
    });
    
  } else {
    // Legally cancel the infinite recurrance loop natively from the DB if disabled!
    await OqronKit.cancel(`bi-weekly-finance-digest:${userId}`);
  }
});
```
