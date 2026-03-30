# Chapter 9: Real-World Examples

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

## 3. Image Processing Pipeline — `taskQueue()`

Monolithic background task with typed I/O, progress tracking, and DLQ.

```typescript
import { taskQueue } from "oqronkit";

type ImageInput = {
  imageId: string;
  sourceUrl: string;
  sizes: Array<{ width: number; height: number; label: string }>;
};

type ImageOutput = {
  imageId: string;
  variants: Array<{ label: string; url: string; sizeKb: number }>;
};

export const imageQueue = taskQueue<ImageInput, ImageOutput>({
  name: "image-processing",
  concurrency: 3,
  guaranteedWorker: true,
  retries: { max: 2, strategy: "exponential", baseDelay: 3000 },
  removeOnComplete: { count: 500 },

  deadLetter: {
    enabled: true,
    onDead: async (job) => {
      await slack.send(`🚨 Image ${job.data.imageId} permanently failed`);
    },
  },

  handler: async (ctx) => {
    const { imageId, sourceUrl, sizes } = ctx.data;
    ctx.progress(10, "Downloading original");

    const variants = [];
    for (let i = 0; i < sizes.length; i++) {
      const size = sizes[i];
      const pct = 20 + Math.floor((70 * (i + 1)) / sizes.length);
      ctx.progress(pct, `Resizing: ${size.label}`);

      const result = await imageService.resize(sourceUrl, size);
      variants.push({ label: size.label, url: result.url, sizeKb: result.sizeKb });
    }

    ctx.progress(100, "Complete");
    return { imageId, variants };
  },
});

// ── Usage ────────────────────────────────────────────────────────
app.post("/api/images", async (req, res) => {
  const job = await imageQueue.add(
    { imageId: req.body.id, sourceUrl: req.body.url, sizes: req.body.sizes },
    { jobId: `img-${req.body.id}` }  // Idempotent
  );
  res.json({ jobId: job.id, status: job.status });
});
```

---

## 4. Order Fulfillment — `Queue` + `Worker`

Decoupled architecture where API servers push orders and dedicated worker pods process them.

```typescript
import { Queue, Worker, QueueEvents } from "oqronkit";

type OrderData = {
  orderId: string;
  items: Array<{ sku: string; qty: number; price: number }>;
  customerId: string;
  shippingAddress: string;
};

// ── API Server (zero processing overhead) ───────────────────────
export const orderQueue = new Queue<OrderData>("order-processing", {
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
  },
});

app.post("/api/orders", async (req, res) => {
  const job = await orderQueue.add("process", req.body);
  res.json({ orderId: req.body.orderId, jobId: job.id });
});

// ── Worker Pod (scales independently) ───────────────────────────
export const orderWorker = new Worker(
  "order-processing",
  async (job) => {
    const { orderId, items, customerId, shippingAddress } = job.data;

    await inventoryService.validate(items);
    await paymentService.charge(orderId, items);
    const label = await shippingService.createLabel(shippingAddress);

    const total = items.reduce((sum, i) => sum + i.price * i.qty, 0);
    return { orderId, status: "fulfilled", total, trackingNumber: label.tracking };
  },
  {
    concurrency: 5,
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 500 },
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
  }
);

// ── Monitoring Pod (real-time observability) ─────────────────────
export const orderEvents = new QueueEvents("order-processing");

orderEvents.on("completed", ({ jobId, returnvalue }) => {
  metrics.increment("orders.fulfilled");
});

orderEvents.on("failed", ({ jobId, failedReason }) => {
  metrics.increment("orders.failed");
});
```

---

## 5. Bulk Notification Blast — `Queue` with Rate Limiting

Send push notifications to 10,000 users without overwhelming the push service.

```typescript
import { Queue, Worker } from "oqronkit";

export const notifQueue = new Queue<{
  userId: string;
  channel: "push" | "sms" | "email";
  title: string;
  body: string;
}>("notifications");

export const notifWorker = new Worker(
  "notifications",
  async (job) => {
    const { userId, channel, title, body } = job.data;
    await notificationService.send(userId, channel, { title, body });
    return { delivered: true };
  },
  {
    concurrency: 10,
    limiter: { max: 100, duration: 60_000 },  // Max 100/min
    retries: { max: 3, strategy: "fixed", baseDelay: 5000 },
  }
);

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

## 6. Email with Delay + Idempotency — `taskQueue()`

Send a welcome email 5 minutes after signup, guaranteed exactly-once delivery.

```typescript
import { taskQueue } from "oqronkit";

export const emailQueue = taskQueue<
  { to: string; subject: string; template: string; vars: Record<string, string> },
  { messageId: string }
>({
  name: "email-sender",
  concurrency: 5,
  retries: { max: 3, strategy: "fixed", baseDelay: 10_000 },
  removeOnComplete: { count: 200, age: 86400 },

  handler: async (ctx) => {
    const result = await ses.sendTemplatedEmail({
      to: ctx.data.to,
      template: ctx.data.template,
      vars: ctx.data.vars,
    });
    return { messageId: result.MessageId };
  },
});

// ── Usage with delay and idempotency ────────────────────────────
app.post("/api/auth/signup", async (req, res) => {
  const user = await db.createUser(req.body);

  await emailQueue.add(
    {
      to: user.email,
      subject: `Welcome, ${user.name}!`,
      template: "welcome",
      vars: { name: user.name, loginUrl: "https://app.example.com" },
    },
    {
      delay: 300_000,                    // 5 minutes after signup
      jobId: `welcome-${user.email}`,   // Exactly-once: won't duplicate
    }
  );

  res.json({ userId: user.id });
});
```

---

## 7. System-Wide Telemetry — `OqronEventBus`

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

This works for cron, schedule, taskQueue, and distributed worker jobs — all emit through the same EventBus.

---

## 8. ETL Pipeline with Job Dependencies — `taskQueue()` DAG

Chain extract → transform → load steps, where each step waits for its parent to complete:

```typescript
import { taskQueue } from "oqronkit";

// Step 1: Extract raw data
const extractQueue = taskQueue<
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
const transformQueue = taskQueue<
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
const loadQueue = taskQueue<
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

---

## 9. Multi-Region Cron Scheduling — `clustering`

Distribute cron schedules across US-East and EU-West for low-latency execution:

```typescript
// ── config.us-east.ts (deployed to us-east pods) ────────────────
import { defineConfig } from "oqronkit";

export default defineConfig({
  project: "global-saas",
  environment: "production",
  modules: ["scheduler"],

  scheduler: {
    clustering: {
      totalShards: 8,
      ownedShards: [0, 1, 2, 3],  // US-East handles shards 0-3
      region: "us-east",
    },
  },
});

// ── config.eu-west.ts (deployed to eu-west pods) ────────────────
import { defineConfig } from "oqronkit";

export default defineConfig({
  project: "global-saas",
  environment: "production",
  modules: ["scheduler"],

  scheduler: {
    clustering: {
      totalShards: 8,
      ownedShards: [4, 5, 6, 7],  // EU-West handles shards 4-7
      region: "eu-west",
    },
  },
});
```

Schedule names are MD5-hashed to a shard index. For example, `"billing-monthly"` might hash to shard 2 (US-East), while `"gdpr-cleanup"` might hash to shard 6 (EU-West). If EU-West goes down, US-East nodes can claim those shard locks after TTL expiry.

---

## 10. Sandboxed User Code Runner — `Worker` with `sandbox`

Execute user-uploaded scripts with memory caps and execution timeouts:

```typescript
import { Queue, Worker } from "oqronkit";

type UserCodeInput = {
  userId: string;
  scriptPath: string;    // Pre-validated and stored on server
  inputData: unknown;
};

// ── API Server ──────────────────────────────────────────────────
const codeQueue = new Queue<UserCodeInput>("user-code");

app.post("/api/run-script", async (req, res) => {
  const scriptPath = await scriptStore.save(req.body.code, req.user.id);
  const job = await codeQueue.add("execute", {
    userId: req.user.id,
    scriptPath,
    inputData: req.body.input,
  });
  res.json({ jobId: job.id, status: "queued" });
});

// ── Sandboxed Worker Pod ────────────────────────────────────────
const codeWorker = new Worker(
  "user-code",
  "./processors/run-user-script.js",
  {
    concurrency: 5,
    sandbox: {
      enabled: true,
      timeout: 10_000,     // Kill after 10 seconds
      maxMemoryMb: 128,    // Hard cap at 128MB
      transferOnly: true,  // No shared memory
    },
    hooks: {
      onSuccess: async (job, result) => {
        await resultsDb.save(job.data.userId, result);
      },
      onFail: async (job, error) => {
        logger.warn(`User script failed: ${job.data.userId}`, { error: error.message });
      },
    },
  }
);
```

```typescript
// ── ./processors/run-user-script.js ─────────────────────────────
import { parentPort, workerData } from "node:worker_threads";

const { job } = workerData;
const userModule = await import(job.data.scriptPath);
const result = await userModule.default(job.data.inputData);
parentPort?.postMessage(result);
```

The sandbox ensures:
- 🛡️ User code cannot access the parent process heap or file system beyond its scope
- ⏱️ Infinite loops are force-killed after the timeout
- 💾 Memory leaks crash the sandbox thread, not the host process

