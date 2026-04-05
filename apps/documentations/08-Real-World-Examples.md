# Chapter 7: Real-World Examples

Production-grade examples demonstrating each OqronKit module in realistic scenarios.

---

## 1. Nightly Database Cleanup — `cron()`

Global sweep that runs at midnight UTC. No payload, no user trigger — pure infrastructure.

```typescript
import { cron } from "oqronkit";

export const midnightCleanup = cron({
  name: "auth-token-purger",
  expression: "0 0 * * *",
  overlap: "skip",
  disabledBehavior: "skip",
  timeout: 3_600_000,
  keepHistory: 30,
  retries: { max: 2, strategy: "exponential", baseDelay: 10_000 },

  handler: async (ctx) => {
    ctx.logger.info("Starting nightly cleanup");
    ctx.progress(20, "Purging expired sessions");
    const sessions = await db.delete("sessions", { expiresAt: { lt: new Date() } });

    ctx.progress(60, "Cleaning orphaned uploads");
    const uploads = await storage.removeOrphanedFiles();

    ctx.progress(100, "Cleanup complete");
    return { sessionsPurged: sessions, filesRemoved: uploads };
  },
});
```

---

## 2. Abandoned Cart Reminder — `schedule()`

User-specific delayed action. Cart created → wait 4 hours → send email.

```typescript
import { schedule, OqronKit } from "oqronkit";

export const cartReminder = schedule<{ userId: string; cartTotal: number }>({
  name: "abandoned-cart",
  overlap: "run",
  disabledBehavior: "hold", 
  retries: { max: 3, strategy: "fixed", baseDelay: 15_000 },
  keepHistory: 50,

  handler: async (ctx) => {
    const { userId, cartTotal } = ctx.payload;
    await emailService.send({
      to: userId,
      template: "abandoned-cart",
      vars: { cartTotal: `$${cartTotal.toFixed(2)}` },
    });
    return { emailSent: true };
  },
});

// ── In your API routes ───────────────────────────────────────────

// When user adds items to cart:
app.post("/api/cart/update", async (req, res) => {
  await cartReminder.schedule({
    nameSuffix: `user-${req.user.id}`,
    runAfter: { hours: 4 },
    payload: { userId: req.user.id, cartTotal: req.body.total },
  });
  res.json({ ok: true });
});

// When user checks out — cancel the reminder:
app.post("/api/cart/checkout", async (req, res) => {
  await OqronKit.cancel(`abandoned-cart:user-${req.user.id}`);
  res.json({ ok: true });
});
```

---

## 3. Order Fulfillment — `queue()` 

Horizontally scalable monolithic API where business logic is strictly organized but inherently decoupled via load balancers natively.

```typescript
import { queue } from "oqronkit";

type OrderData = {
  orderId: string;
  items: Array<{ sku: string; qty: number; price: number }>;
  customerId: string;
  shippingAddress: string;
};

// ── Shared Process Definition ───────────────────────
export const orderQueue = queue<OrderData>("order-processing", {
  concurrency: 5,
  disabledBehavior: "hold",
  removeOnComplete: { count: 1000 },
  retries: {
    max: 3,
    strategy: "exponential",
    baseDelay: 2000
  },
  hooks: {
    onSuccess: async (job, result) => {
      console.log(`✅ Order ${result.orderId}: ${result.trackingNumber}`);
    },
    onFail: async (job, error) => {
      await alertOps(`Order ${job.data.orderId} failed: ${error.message}`);
    },
  },
  deadLetter: {
    enabled: true,
    onDead: async (job) => {
      await manualReviewQueue.add({ source: "orders", job });
    },
  },
  handler: async (ctx) => {
    const { orderId, items, customerId, shippingAddress } = ctx.data;

    await inventoryService.validate(items);
    if(ctx.signal.aborted) return;
    
    await paymentService.charge(orderId, items);
    const label = await shippingService.createLabel(shippingAddress);

    const total = items.reduce((sum, i) => sum + i.price * i.qty, 0);
    return { orderId, status: "fulfilled", total, trackingNumber: label.tracking };
  }
});

// ── In your API layer ───────────────────────────
app.post("/api/orders", async (req, res) => {
  const job = await orderQueue.add("process", req.body);
  res.json({ orderId: req.body.orderId, jobId: job.id });
});
```

---

## 4. Bulk Notification Blast — `queue()` with Rate Limiting

Send push notifications to 10,000 users without overwhelming the push service.

```typescript
import { queue } from "oqronkit";

export const notifQueue = queue<{
  userId: string;
  channel: "push" | "sms" | "email";
  title: string;
  body: string;
}>({
  name: "notifications",
  concurrency: 10,
  
  // Note: OqronKit utilizes Global Config Limiters for dynamic rate structures depending on scale
  // But backoff inherently throttles downstream failures
  retries: { max: 3, strategy: "fixed", baseDelay: 5000 },
  
  handler: async (ctx) => {
    const { userId, channel, title, body } = ctx.data;
    await notificationService.send(userId, channel, { title, body });
    return { delivered: true };
  }
});

// Bulk enqueue for all users
app.post("/api/admin/announce", async (req, res) => {
  const userIds = await db.getAllActiveUserIds();

  await notifQueue.addBulk(
    userIds.map(id => ({
      name: "announce",
      data: {
        userId: id,
        channel: "push" as const,
        title: req.body.title,
        body: req.body.body,
      },
    }))
  );

  res.json({ queued: userIds.length });
});
```

---

## 5. System-Wide Telemetry — `OqronEventBus`

Monitor all job activity across every module from a single listener:

```typescript
import { OqronEventBus } from "oqronkit";

// ── Prometheus-style metrics ─────────────────────────────────────
OqronEventBus.on("job:start", (queueName, jobId, module) => {
  metrics.increment(`oqron.jobs.started`, { queue: queueName, module });
});

OqronEventBus.on("job:success", (queueName, jobId) => {
  metrics.increment(`oqron.jobs.completed`, { queue: queueName });
});

OqronEventBus.on("job:fail", (queueName, jobId, error) => {
  metrics.increment(`oqron.jobs.failed`, { queue: queueName });
  logger.error(`Job failed: ${queueName}/${jobId}`, { error: error.message });
});
```

This works for cron, schedule, queue, and webhook jobs — all emit identically through the same EventBus.

---

## 6. ETL Pipeline with Job Dependencies — `queue()` DAG

Chain extract → transform → load steps, where each step waits for its parent to complete:

```typescript
import { queue } from "oqronkit";

// Step 1: Extract raw data
const extractQueue = queue<
  { source: string; format: "csv" | "json" },
  { rowCount: number; tempPath: string }
>({
  name: "etl-extract",
  concurrency: 3,
  retries: { max: 2, strategy: "fixed", baseDelay: 5_000 },

  handler: async (ctx) => {
    ctx.progress(10, "Downloading source file");
    const data = await dataLake.download(ctx.data.source);
    const parsed = await parser.parse(data, ctx.data.format);
    const tempPath = await tempStorage.write(parsed);
    ctx.progress(100, "Extraction complete");
    return { rowCount: parsed.length, tempPath };
  },
});

// Step 2: Transform (waits for extract)
const transformQueue = queue<
  { tempPath: string; transformations: string[] },
  { outputPath: string; processedRows: number }
>({
  name: "etl-transform",
  concurrency: 2,
  handler: async (ctx) => {
    const raw = await tempStorage.read(ctx.data.tempPath);
    const results = await transformer.apply(raw, ctx.data.transformations);
    const outputPath = await tempStorage.write(results);
    return { outputPath, processedRows: results.length };
  },
});

// Step 3: Load (waits for transform)
const loadQueue = queue<
  { outputPath: string; targetTable: string },
  { insertedRows: number }
>({
  name: "etl-load",
  concurrency: 1,
  handler: async (ctx) => {
    const data = await tempStorage.read(ctx.data.outputPath);
    return await warehouse.bulkInsert(ctx.data.targetTable, data);
  },
});

// ── Orchestration ────────────────────────────────────────────────
app.post("/api/etl/run", async (req, res) => {
  // Step 1: Extract
  const extractJob = await extractQueue.add({
    source: req.body.source,
    format: req.body.format,
  });

  // Step 2: Transform waits for extract
  const transformJob = await transformQueue.add(
    { tempPath: "", transformations: req.body.transforms },
    {
      dependsOn: [extractJob.id],
      parentFailurePolicy: "cascade-fail",
    }
  );

  // Step 3: Load waits for transform
  const loadJob = await loadQueue.add(
    { outputPath: "", targetTable: req.body.target },
    {
      dependsOn: [transformJob.id],
      parentFailurePolicy: "cascade-fail",
    }
  );

  res.json({
    pipeline: {
      extract: extractJob.id,
      transform: transformJob.id,
      load: loadJob.id,
    },
  });
});
```
