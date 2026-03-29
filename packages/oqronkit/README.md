# OqronKit

![Version](https://img.shields.io/npm/v/oqronkit?style=flat-square)
![License](https://img.shields.io/npm/l/oqronkit?style=flat-square)

**OqronKit** is a crash-safe, framework-agnostic background computation engine for Node.js. One package replaces your cron scheduler, job queue, retry engine, dead letter queue, and distributed locking infrastructure.

Deploy as a single-server monolith or a horizontally-scaled microservice architecture — same code, zero changes.

## ✨ What's New in `0.0.1-alpha.3`

- **DI Container** (`OqronContainer`) — replaces module globals with injectable, testable, multi-instance-ready container
- **Job Cancellation** — `AbortController`-based mid-execution cancel via `ctx.signal`
- **Job Ordering** — FIFO, LIFO, and Priority strategies across all brokers
- **PostgreSQL Adapter** — `FOR UPDATE SKIP LOCKED` atomic claiming, JSONB+GIN storage, advisory locks
- **Redis Adapter Suite** — Sorted sets for ordering, Lua scripts for atomicity, Redlock for distributed locks
- **253 tests across 26 files** — A+ maturity rating on all 16 modules

---

## 🌟 Key Features

| Feature | Description |
|---------|-------------|
| **4 Production Modules** | Cron, Schedule, TaskQueue, Queue+Worker |
| **3 Adapter Backends** | Memory (dev), Redis, PostgreSQL |
| **Crash-Safe Processing** | Heartbeat locks + stall detection + auto-recovery |
| **Mid-Execution Cancel** | `AbortController` — handlers check `ctx.signal.aborted` |
| **Job Ordering** | FIFO, LIFO, Priority — per-queue or global config |
| **Retry & Backoff** | Fixed + exponential with configurable caps |
| **Dead Letter Queue** | Hooks fire when all retries exhausted |
| **Progress Tracking** | `ctx.progress(50, "halfway")` — real-time via EventBus |
| **Environment Isolation** | `project:environment` namespacing prevents cross-env leaks |
| **Leader Election** | Only one node polls for due schedules — reduces DB load by N× |
| **DI Container** | `OqronContainer` for multi-instance and testability |
| **Graceful Shutdown** | Drain active jobs, release locks, close adapters |
| **Telemetry** | Prometheus-compatible metrics (p50/p95/p99) |
| **Admin API** | Express/Fastify routers for health, events, trigger, queue/job management |

---

## 📦 Installation

```bash
npm install oqronkit
# or
bun add oqronkit
```

### Optional peer dependencies

```bash
# For Redis adapter:
npm install ioredis

# For PostgreSQL adapter:
npm install pg
```

---

## 🚀 Quick Start

### 1. Configuration

```typescript
import { defineConfig } from "oqronkit";

export default defineConfig({
  project: "my-saas",
  environment: process.env.NODE_ENV ?? "development",
  modules: ["cron", "scheduler", "taskQueue", "worker"],
  jobsDir: "./src/jobs",

  // Optional — connects PostgreSQL adapters automatically:
  // postgres: { connectionString: "postgresql://..." },

  // Optional — connects Redis adapters automatically:
  // redis: "redis://localhost:6379",
});
```

### 2. Define a Cron Job

```typescript
import { cron } from "oqronkit";

export const dailyDigest = cron({
  name: "daily-digest",
  expression: "0 8 * * *",
  timezone: "UTC",
  overlap: "skip",
  handler: async (ctx) => {
    ctx.log.info("Sending digest emails...");
    return { processed: 50 };
  },
});
```

### 3. Define a Task Queue (Monolithic)

```typescript
import { taskQueue } from "oqronkit";

const imageQueue = taskQueue<{ url: string }, { variants: string[] }>({
  name: "image-processing",
  concurrency: 3,
  strategy: "fifo",          // "fifo" | "lifo" | "priority"
  guaranteedWorker: true,     // Crash-safe heartbeat lock

  retries: { max: 2, strategy: "exponential", baseDelay: 3000 },

  handler: async (ctx) => {
    // Check cancellation signal periodically
    if (ctx.signal.aborted) return { variants: [] };

    ctx.progress(50, "Resizing images");
    const variants = await resize(ctx.data.url);

    ctx.progress(100, "Done");
    return { variants };
  },
});

// Enqueue from anywhere:
await imageQueue.add({ url: "https://..." }, { jobId: "img-123" });
```

### 4. Define a Distributed Queue + Worker

```typescript
import { Queue, Worker } from "oqronkit";

// Publisher (API pods — zero CPU overhead)
const orderQueue = new Queue("orders", {
  defaultJobOptions: { attempts: 3, backoff: { type: "exponential", delay: 2000 } },
});
await orderQueue.add("process", { orderId: "ORD-1" });

// Consumer (Worker pods — horizontally scaled)
const orderWorker = new Worker("orders", async (job) => {
  await processOrder(job.data);
  return { status: "shipped" };
}, {
  concurrency: 10,
  strategy: "priority",
});
```

### 5. Boot

```typescript
import { OqronKit } from "oqronkit";

await OqronKit.init();
console.log("OqronKit ready ✓");
```

---

## 🔧 Job Cancellation

Cancel active jobs mid-execution via `AbortController`:

```typescript
import { OqronManager } from "oqronkit";

const mgr = OqronManager.from(OqronKit.getConfig());
await mgr.cancelJob("job-id"); // Fires AbortSignal → handler sees ctx.signal.aborted
```

Handlers should check `ctx.signal.aborted` periodically:

```typescript
handler: async (ctx) => {
  for (const chunk of data) {
    if (ctx.signal.aborted) return;  // Exit early
    await process(chunk);
  }
}
```

---

## 🏗 Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        OqronKit Engine                           │
├──────────────┬──────────────┬──────────────┬────────────────────┤
│   Cron       │   Schedule   │  TaskQueue   │  Queue + Worker    │
│  (time)      │  (data)      │  (monolith)  │  (distributed)     │
├──────────────┴──────────────┴──────────────┴────────────────────┤
│                    Shared Infrastructure                         │
│  ┌─────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────────┐  │
│  │ Storage  │ │  Broker  │ │   Lock   │ │  Backoff / Prune   │  │
│  └─────────┘ └──────────┘ └──────────┘ └────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│            OqronContainer (DI)  →  Proxy Shims                   │
├─────────────────────────────────────────────────────────────────┤
│                     Adapter Layer                                │
│     Memory (dev) ←──→ Redis ←──→ PostgreSQL (production)          │
└──────────────────────────────────────────────────────────────────┘
```

---

## 📊 Test Coverage

| Metric | Value |
|--------|:-----:|
| Test Files | **26** |
| Tests Passing | **253** |
| Type Errors | **0** |
| Module Maturity | **A+ across all 16 modules** |

---

## 📖 Documentation

Full documentation in [`apps/documentations/`](../../apps/documentations/README.md):

1. [Introduction](../../apps/documentations/01-Introduction.md)
2. [Core Concepts](../../apps/documentations/02-Core-Concepts.md)
3. [Cron & Schedule](../../apps/documentations/03-Module-Guide-Cron-and-Schedule.md)
4. [TaskQueue](../../apps/documentations/04-Module-Guide-TaskQueue.md)
5. [Queue + Worker](../../apps/documentations/05-Module-Guide-Queue-Worker.md)
6. [TaskQueue vs Queue/Worker](../../apps/documentations/06-TaskQueue-vs-Queue-Worker.md)
7. [Job Lifecycle & Retention](../../apps/documentations/07-Job-Lifecycle-and-Retention.md)
8. [Configuration Reference](../../apps/documentations/08-Configuration-Reference.md)
9. [Real-World Examples](../../apps/documentations/09-Real-World-Examples.md)
10. [Roadmap](../../apps/documentations/10-Roadmap-and-Future.md)

---

## 🤝 Contributing

1. Fork the project
2. Create your feature branch (`git checkout -b feat/my-feature`)
3. Write tests in `test/<module>/`
4. Ensure `bunx vitest run` and `bunx tsc --noEmit` pass
5. Open a Pull Request

## 📜 License

[MIT](./LICENSE)
