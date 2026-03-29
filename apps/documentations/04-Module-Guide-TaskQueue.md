# Chapter 4: TaskQueue Module

## Overview

The `taskQueue()` factory creates a **monolithic** background task processor where the publisher and consumer live in the **same process**. You define the queue and handler together, then call `.add()` from anywhere in your app.

This is the simplest way to add background processing to a Node.js application — no separate worker processes, no message broker configuration.

---

## When to Use TaskQueue

- **Single-server applications** or small deployments
- **API-triggered background work** (image processing, email sending, PDF generation)
- **Prototyping** — get background processing running in 5 minutes, migrate to distributed later
- **Tasks that need tight coupling** with your main application (shared database connections, in-memory state)

> **Note:** If you need to scale your worker processing across multiple servers independently from your API, use `Queue` + `Worker` instead. See [Chapter 6](./06-TaskQueue-vs-Queue-Worker.md) for a detailed comparison.

---

## API Reference

### `taskQueue<T, R>(config)` → `ITaskQueue<T, R>`

Creates and registers a task queue. Returns an object with `.add()` method.

```typescript
import { taskQueue } from "oqronkit";

const myQueue = taskQueue<InputType, OutputType>({
  name: "my-task",
  handler: async (ctx) => {
    // Process ctx.data
    return result;
  },
});
```

### Config Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | required | Unique queue identifier |
| `handler` | `(ctx: TaskJobContext<T>) => Promise<R>` | required | The processing function |
| `concurrency` | `number` | `5` | Parallel execution limit |
| `guaranteedWorker` | `boolean` | `true` | Enable heartbeat lock for crash safety |
| `heartbeatMs` | `number` | `5000` | Heartbeat ping interval |
| `lockTtlMs` | `number` | `30000` | Lock expiry for crash detection |
| `retries.max` | `number` | `0` | Maximum retry attempts after first failure |
| `retries.strategy` | `"fixed" \| "exponential"` | `"exponential"` | Backoff algorithm |
| `retries.baseDelay` | `number` | `2000` | Base delay between retries in ms |
| `retries.maxDelay` | `number` | `60000` | Maximum delay cap for exponential backoff |
| `removeOnComplete` | `boolean \| number \| KeepJobs` | `false` | Auto-prune completed jobs |
| `removeOnFail` | `boolean \| number \| KeepJobs` | `false` | Auto-prune failed jobs |
| `deadLetter.enabled` | `boolean` | `true` | Enable dead letter queue |
| `deadLetter.onDead` | `(job) => Promise<void>` | — | Hook called when all retries exhausted |
| `hooks.onSuccess` | `(job, result) => void` | — | Called after successful processing |
| `hooks.onFail` | `(job, error) => void` | — | Called after failed processing |

### `TaskJobContext<T>` — The Handler Context

Your handler receives a context object with these capabilities:

```typescript
handler: async (ctx) => {
  ctx.id;                           // Job UUID
  ctx.data;                         // Typed input payload
  ctx.progress(50, "Halfway done"); // Update progress (0-100)
  ctx.log("info", "Processing...");  // Structured logging
  ctx.discard();                     // Permanently fail — skip all retries
}
```

### `.add(data, opts?)` — Enqueue a Job

```typescript
await myQueue.add(
  { userId: "u_123", action: "process" },  // Typed data
  {
    jobId: "custom-idempotency-key",        // Prevent duplicate processing
    delay: 60_000,                          // Wait 60s before processing
    priority: 1,                            // Lower = higher priority
    attempts: 5,                            // Override retry count for this job
    backoff: { type: "fixed", delay: 3000 },// Override backoff for this job
    removeOnComplete: { count: 100 },       // Keep only last 100 completed
  }
);
```

---

## Full Example: Image Processing Pipeline

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

  retries: {
    max: 2,
    strategy: "exponential",
    baseDelay: 3000,
  },

  deadLetter: {
    enabled: true,
    onDead: async (job) => {
      await alertSlack(`Image ${job.data.imageId} permanently failed`);
    },
  },

  hooks: {
    onSuccess: async (_job, result) => {
      console.log(`✅ Image ${result.imageId}: ${result.variants.length} variants`);
    },
  },

  handler: async (ctx) => {
    const { imageId, sourceUrl, sizes } = ctx.data;
    ctx.progress(10, "Downloading");

    const variants = [];
    for (let i = 0; i < sizes.length; i++) {
      const size = sizes[i];
      ctx.progress(20 + Math.floor((70 * (i + 1)) / sizes.length),
        `Resizing: ${size.label}`);

      // ... actual resize logic ...
      variants.push({
        label: size.label,
        url: `https://cdn.example.com/${imageId}/${size.label}.webp`,
        sizeKb: 350,
      });
    }

    ctx.progress(100, "Complete");
    return { imageId, variants };
  },
});

// ── Usage in API route ──────────────────────────────────────────
app.post("/api/images/upload", async (req, res) => {
  await imageQueue.add(
    { imageId: req.body.id, sourceUrl: req.body.url, sizes: req.body.sizes },
    { jobId: `img-${req.body.id}` }  // Idempotent
  );
  res.json({ status: "processing" });
});
```

---

## Retry & Backoff Behavior

When a handler throws an error, OqronKit's retry engine kicks in:

```
Attempt 1: Execute handler
  → Throws Error
  → Calculate backoff: exponential(3000ms, attempt=1) = 3000ms
  → Wait 3000ms

Attempt 2: Execute handler
  → Throws Error
  → Calculate backoff: exponential(3000ms, attempt=2) = 6000ms
  → Wait 6000ms

Attempt 3: Execute handler
  → Throws Error
  → All retries exhausted (max: 2)
  → Job status → "failed"
  → DLQ hook fires
  → hooks.onFail fires
```

The `discard()` method bypasses retries entirely — the job is immediately marked as permanently failed.
