# Chapter 6: TaskQueue vs Queue/Worker — When to Use Which

## The Core Difference

Both `taskQueue()` and `Queue`/`Worker` process background jobs. The fundamental difference is **where the handler runs**:

| | `taskQueue()` | `Queue` + `Worker` |
|---|---|---|
| **Architecture** | Monolithic (single process) | Distributed (multi-process) |
| **Publisher** | `.add()` in same process | `Queue.add()` in API pod |
| **Consumer** | `handler` in same process | `Worker processor` in worker pod |
| **Connection** | Everything shares memory | Connected via Broker (Redis) |
| **Scaling** | Scale the entire app | Scale workers independently |

---

## Visual Comparison

### TaskQueue (Monolithic)

```
┌─────────────────────────────────────────────────┐
│              Single Node.js Process             │
│                                                 │
│   API Route                                     │
│   └→ taskQueue.add({ ... })                     │
│       └→ [Storage] → [Broker] → [Handler]       │
│                                    ↓             │
│                              Process locally     │
│                              Return result       │
└─────────────────────────────────────────────────┘
```

### Queue/Worker (Distributed)

```
┌──────────────────────┐        ┌──────────────────────┐
│   API Server Pod     │        │   Worker Pod          │
│                      │        │                       │
│   API Route          │        │   Worker              │
│   └→ queue.add()     │───────→│   └→ processor(job)   │
│                      │ Broker │       ↓               │
│   (no processing)    │(Redis) │   Process job         │
│   (instant response) │        │   Return result       │
└──────────────────────┘        └──────────────────────┘
```

---

## Decision Matrix

| Question | TaskQueue | Queue/Worker |
|----------|:---------:|:------------:|
| Do publisher and consumer need to be in separate processes? | ❌ | ✅ |
| Do you need to scale workers independently from API servers? | ❌ | ✅ |
| Is this a single-server or small deployment? | ✅ | ❌ |
| Do you need the simplest possible API? | ✅ | ❌ |
| Are you prototyping that might go distributed later? | ✅ | ~ |
| Do you need >100 concurrent workers across many pods? | ❌ | ✅ |
| Does the handler need access to in-process state (globals, caches)? | ✅ | ❌ |
| Is the handler CPU-intensive and would slow down API responses? | ~ | ✅ |
| Do you need real-time event streaming via `QueueEvents`? | ❌ | ✅ |
| Do you need rate limiting (`limiter`)? | ❌ | ✅ |

---

## Feature Comparison

Both modules share the same underlying infrastructure and support the same enterprise features:

| Feature | TaskQueue | Queue/Worker |
|---------|:---------:|:------------:|
| **Typed generics** `<Input, Output>` | ✅ | ✅ |
| **Retry/backoff** (fixed + exponential) | ✅ | ✅ |
| **Dead Letter Queue** hooks | ✅ | ✅ |
| **Job retention/pruning** (removeOnComplete/Fail) | ✅ | ✅ |
| **Environment isolation** | ✅ | ✅ |
| **Delay** (scheduled execution) | ✅ | ✅ |
| **Custom jobId** (idempotency) | ✅ | ✅ |
| **Success/failure hooks** | ✅ | ✅ |
| **Stacktrace capture** | ✅ | ✅ |
| **Graceful shutdown** | ✅ | ✅ |
| **Progress tracking** | ✅ `ctx.progress()` | — |
| **Structured logging** | ✅ `ctx.log()` | — |
| **Discard** (permanent fail) | ✅ `ctx.discard()` | — |
| **Rate limiting** | — | ✅ `limiter` |
| **QueueEvents** (real-time streaming) | — | ✅ |
| **Bulk publishing** | — | ✅ `addBulk()` |
| **Sandboxed processors** (worker threads) | — | ✅ |

---

## Code Comparison

### Same Task — Two Ways

**TaskQueue approach** (monolithic):
```typescript
import { taskQueue } from "oqronkit";

export const emailQueue = taskQueue<EmailInput, EmailOutput>({
  name: "email-sender",
  concurrency: 5,
  retries: { max: 3, strategy: "fixed", baseDelay: 10_000 },

  handler: async (ctx) => {           // Handler defined here
    ctx.log("info", `Sending to ${ctx.data.to}`);
    ctx.progress(50, "Rendering template");
    const result = await sendEmail(ctx.data);
    return result;
  },
});

// Enqueue
await emailQueue.add({ to: "user@example.com", subject: "Hello" });
```

**Queue/Worker approach** (distributed):
```typescript
import { Queue, Worker } from "oqronkit";

// ── In your API server ──────────────────────────────────────────
export const emailQueue = new Queue<EmailInput>("email-sender");

// Enqueue (identical API)
await emailQueue.add("send", { to: "user@example.com", subject: "Hello" });

// ── In your worker server ───────────────────────────────────────
export const emailWorker = new Worker(
  "email-sender",
  async (job) => {                    // Handler lives separately
    console.log(`Sending to ${job.data.to}`);
    const result = await sendEmail(job.data);
    return result;
  },
  {
    concurrency: 5,
    retries: { max: 3, strategy: "fixed", baseDelay: 10_000 },
  }
);
```

Notice:
- **Same queue name** (`"email-sender"`) connects publisher to consumer
- **Same retry config** — just positioned differently
- **Same data types** flow through both
- **TaskQueue** bundles everything together; **Queue/Worker** splits publisher from consumer

---

## Migration Path: TaskQueue → Queue/Worker

If you start with `taskQueue()` and later need to scale, the migration is straightforward:

1. Extract the `handler` into a `Worker`
2. Replace `taskQueue()` with `new Queue()`
3. Keep the same `name`
4. Move retry/DLQ config to the Worker options

Your `.add()` call sites remain identical. The queue name is the contract between publisher and consumer.

---

## When to Use Both Together

In a real production system, you might use **both** patterns:

```typescript
// ── TaskQueue: Fast, low-overhead internal tasks ────────────────
const auditLogQueue = taskQueue({
  name: "audit-log",
  handler: async (ctx) => { await db.insert("audit_logs", ctx.data); },
});

// ── Queue/Worker: Heavy, scalable external processing ───────────
const videoQueue = new Queue("video-transcode");
const videoWorker = new Worker("video-transcode", transcode, {
  concurrency: 2,  // GPU-bound, limited concurrency
});
```

Use `taskQueue` for lightweight, fire-and-forget background work that doesn't need independent scaling. Use `Queue`/`Worker` for heavy or high-throughput processing that benefits from dedicated worker infrastructure.
