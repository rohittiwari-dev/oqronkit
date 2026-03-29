# Chapter 5: Queue + Worker Module (Distributed Architecture)

## Overview

The `Queue` and `Worker` classes implement a **distributed** producer-consumer architecture. The publisher (`Queue`) and processor (`Worker`) are completely decoupled — they can live in different processes, different containers, even different regions.

This is OqronKit's answer to enterprise-scale job processing where your API servers should push jobs with **zero processing overhead** while dedicated worker pods handle the heavy lifting.

---

## When to Use Queue + Worker

- **Microservice architectures** — API pods publish, worker pods consume
- **Horizontal scaling** — scale workers independently from API servers
- **High-throughput systems** — API can push 100k jobs/sec without local processing
- **Resource isolation** — CPU-heavy processing doesn't compete with API response times
- **Multi-service communication** — Service A publishes to a queue that Service B consumes

> **Note:** If publisher and consumer are in the same process and you don't need independent scaling, use `taskQueue()` instead. See [Chapter 6](./06-TaskQueue-vs-Queue-Worker.md) for a detailed comparison.

---

## The Three Primitives

### 1. `Queue` — The Publisher (Sender)

A Queue is a **pure sender**. It consumes zero CPU, runs no polling loops, and holds no processing logic. It exists solely to push job records into Storage and signal the Broker.

```typescript
import { Queue } from "oqronkit";

const orderQueue = new Queue<OrderData>("order-processing", {
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
  },
});

// Push a single job
await orderQueue.add("process-order", { orderId: "ORD-123", items: [...] });

// Push multiple jobs in bulk
await orderQueue.addBulk([
  { name: "process-order", data: { orderId: "ORD-124", items: [...] } },
  { name: "process-order", data: { orderId: "ORD-125", items: [...] } },
]);
```

#### Queue API

| Method | Signature | Description |
|--------|-----------|-------------|
| `add` | `(name: string, data: T, opts?: OqronJobOptions)` | Publish a single job |
| `addBulk` | `(jobs: { name, data, opts }[])` | Publish multiple jobs at once |
| `close` | `()` | Graceful cleanup |

#### Constructor Options

| Option | Type | Description |
|--------|------|-------------|
| `defaultJobOptions` | `OqronJobOptions` | Defaults applied to every `.add()` call |

### 2. `Worker` — The Consumer (Processor)

A Worker is a **pure consumer**. It polls the Broker for claimed jobs and executes them. The OqronKit `WorkerEngine` manages the full lifecycle: polling, retry, backoff, DLQ, and pruning.

```typescript
import { Worker } from "oqronkit";

const orderWorker = new Worker(
  "order-processing",                    // Must match Queue name
  async (job) => {                        // Processor function
    const { orderId, items } = job.data;
    console.log(`Processing order ${orderId}`);

    await validateInventory(items);
    await chargePayment(orderId);
    await createShippingLabel(orderId);

    return { status: "fulfilled", trackingNumber: `TRK-${Date.now()}` };
  },
  {
    concurrency: 5,
    retries: { max: 3, strategy: "exponential", baseDelay: 2000 },
    removeOnComplete: { count: 1000 },    // Keep last 1000 completed
    removeOnFail: { count: 500 },         // Keep last 500 failed

    hooks: {
      onSuccess: async (job, result) => {
        console.log(`✅ Order ${job.data.orderId}: ${result.trackingNumber}`);
      },
      onFail: async (job, error) => {
        console.error(`❌ Order ${job.data.orderId}: ${error.message}`);
      },
    },

    deadLetter: {
      enabled: true,
      onDead: async (job) => {
        await alertOpsTeam(`Order ${job.data.orderId} permanently failed`);
      },
    },
  }
);
```

#### Worker Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `concurrency` | `number` | `5` | Parallel job limit |
| `strategy` | `"fifo" \| "lifo" \| "priority"` | `"fifo"` | Job ordering strategy |
| `autorun` | `boolean` | `true` | Start polling when OqronKit boots |
| `connection` | `IBrokerEngine` | — | Override the broker adapter |
| `limiter` | `{ max, duration, groupKey? }` | — | Rate limiting |
| `retries.max` | `number` | global config | Max retry attempts |
| `retries.strategy` | `"fixed" \| "exponential"` | global config | Backoff algorithm |
| `retries.baseDelay` | `number` | global config | Base retry delay (ms) |
| `retries.maxDelay` | `number` | global config | Max delay cap (ms) |
| `removeOnComplete` | `RemoveOnConfig` | `false` | Auto-prune completed jobs |
| `removeOnFail` | `RemoveOnConfig` | `false` | Auto-prune failed jobs |
| `deadLetter.enabled` | `boolean` | global config | Enable DLQ |
| `deadLetter.onDead` | `(job) => Promise<void>` | — | DLQ callback |
| `hooks.onSuccess` | `(job, result) => void` | — | Success callback |
| `hooks.onFail` | `(job, error) => void` | — | Failure callback |

#### Processor Function

The processor receives a full `OqronJob<T, R>` object:

```typescript
async (job) => {
  job.id;              // Unique job identifier
  job.data;            // Typed input payload
  job.opts;            // Job options used when created
  job.attemptMade;     // Current attempt number
  job.status;          // Current lifecycle state
  job.queueName;       // Queue this job belongs to
  job.createdAt;       // When the job was created
  job.startedAt;       // When processing began

  return result;       // Return value stored as job.returnValue
}
```

### 3. `QueueEvents` — The Observer

QueueEvents provides real-time event streaming for monitoring, dashboards, and telemetry — without any processing responsibilities.

```typescript
import { QueueEvents } from "oqronkit";

const events = new QueueEvents("order-processing");

events.on("active",    ({ jobId }) => { /* Job claimed by worker */ });
events.on("progress",  ({ jobId, data }) => { /* Progress update */ });
events.on("completed", ({ jobId, returnvalue }) => { /* Success */ });
events.on("failed",    ({ jobId, failedReason }) => { /* Failure */ });
events.on("stalled",   ({ jobId }) => { /* Worker lost heartbeat */ });
```

---

## Deployment Architecture

```
┌──────────────────────────┐          ┌─────────────────────────────┐
│   API Server Pods (3x)   │          │   Worker Pods (10x)         │
│                          │          │                             │
│  const q = new Queue()   │          │  const w = new Worker()     │
│  await q.add("job", {})  │─────────→│  async (job) => { ... }     │
│                          │  Broker   │                             │
│  Zero processing         │  (Redis)  │  Full processing            │
│  Zero polling            │          │  Retry/backoff              │
│  Instant response        │          │  DLQ hooks                  │
└──────────────────────────┘          └─────────────────────────────┘
                                                    │
                                      ┌─────────────┴───────────────┐
                                      │   Monitoring Pod (1x)       │
                                      │                             │
                                      │  const e = new QueueEvents()│
                                      │  e.on("completed", ...)     │
                                      └─────────────────────────────┘
```

---

## Full Example: Notification Dispatch with Rate Limiting

```typescript
import { Queue, Worker } from "oqronkit";

// ── API Server ──────────────────────────────────────────────────
export const notifQueue = new Queue<{
  userId: string;
  channel: "push" | "sms" | "email";
  title: string;
  body: string;
}>("notifications");

// Bulk send to 10,000 users
await notifQueue.addBulk(
  userIds.map(id => ({
    name: "notify",
    data: { userId: id, channel: "push", title: "New Feature!", body: "..." },
  }))
);

// ── Worker Pod ──────────────────────────────────────────────────
export const notifWorker = new Worker(
  "notifications",
  async (job) => {
    const { userId, channel, title } = job.data;
    await sendNotification(userId, channel, title, job.data.body);
    return { delivered: true };
  },
  {
    concurrency: 10,
    limiter: {
      max: 100,        // Max 100 notifications
      duration: 60_000, // per 60 seconds
    },
    retries: { max: 3, strategy: "fixed", baseDelay: 5000 },
  }
);
```
