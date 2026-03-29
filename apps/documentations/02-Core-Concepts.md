# Chapter 2: Core Concepts

## 1. The Four Modules

OqronKit organizes background work into four distinct modules, each purpose-built for a specific deployment pattern:

| Module | Type | Publisher | Consumer | Best For |
|--------|------|-----------|----------|----------|
| **`cron()`** | Time-driven | Automatic | Same process | Global sweeps, cleanup, metrics |
| **`schedule()`** | Data-driven | API-triggered | Same process | User-specific delays, drip campaigns |
| **`taskQueue()`** | Monolithic | `.add()` | Same process | Single-server background jobs |
| **`Queue` + `Worker`** | Distributed | `Queue.add()` | Separate pods | Microservices, horizontal scaling |

Each module shares the same underlying infrastructure (Storage, Broker, Lock) but exposes a different API surface optimized for its use case.

---

## 2. Multi-Tenant Environment Isolation

You can run `staging`, `development`, and `production` off the same physical database or Redis instance without jobs leaking across environments.

```typescript
import { defineConfig } from "oqronkit";

export default defineConfig({
  project: "my-saas",
  environment: process.env.NODE_ENV,  // "development" | "staging" | "production"
});
```

OqronKit automatically prefixes every database row, execution ID, and lock boundary:
```
${project}:${environment}:${job_name}
```

A `development` worker physically cannot claim or execute a `production` job. This isolation happens at the engine level — no code changes needed per module.

---

## 3. Leader Election

When you deploy 5 API containers onto AWS ECS, allowing all 5 to aggressively poll the database for due jobs would exhaust IOPS limits and spike CPU.

OqronKit features an internal **Heartbeat Leader Election**:

1. All nodes continuously compete for the `oqron:scheduler:leader` key
2. The winning node becomes the **Master Poller** — only it checks for due tasks
3. Due tasks are dispatched via atomic locks to available workers
4. If the leader crashes, the key expires within ~3 seconds and a secondary node takes over

This applies to both the CronEngine and ScheduleEngine automatically.

---

## 4. Crash Safety & Stall Detection

Every OqronKit module supports crash-safe job processing via two mechanisms:

### Heartbeat Workers (`guaranteedWorker: true`)
1. The worker atomically claims a job using the Lock adapter, writing its `workerId` and a TTL
2. A `setInterval` heartbeat renews the lock every N milliseconds while processing
3. If the process crashes (`SIGKILL`/OOM), the lock expires in the database
4. The internal StallDetector reclaims the job and routes it to a living worker within ~15 seconds

### Graceful Shutdown
When a `SIGINT` or `SIGTERM` is received, OqronKit:
1. Stops accepting new jobs from all modules
2. Waits for active jobs to drain (configurable `shutdownTimeout`)
3. Releases all held locks
4. Emits a `closed` event for cleanup hooks

---

## 5. Adapter-Driven Architecture & DI Container

OqronKit never makes direct database calls. All persistence goes through three adapter interfaces, managed by the `OqronContainer`:

| Adapter | Purpose | In-Memory (dev) | Production |
|---------|---------|------------------|------------|
| `IStorageEngine` | Job records, history, schedules | `Map<string, any>` | PostgreSQL (JSONB+GIN) |
| `IBrokerEngine` | Job signaling, claim/ack/nack | In-process queue | Redis Sorted Sets |
| `ILockAdapter` | Distributed locking | Simple mutex | Redis Redlock / PG Advisory |

Switching from in-memory to Redis/Postgres requires **zero code changes** in your job definitions — you only change the adapter config. Business logic stays identical whether you're running monolith or microservices.

### DI Container (`OqronContainer`)

Adapters are held in a central `OqronContainer`, which replaces the legacy module-level globals:

```typescript
import { OqronContainer } from "oqronkit";

// Global singleton (default — backward compatible):
await OqronKit.init({ config: { /* auto-selects adapters */ } });
const storage = OqronContainer.get().storage;

// Multi-instance (advanced — isolated adapters):
const container = new OqronContainer(myStore, myBroker, myLock);
const engine = new TaskQueueEngine(config, logger, container);
```

The existing `Storage`, `Broker`, `Lock` imports continue to work unchanged — they are Proxy objects that delegate to the global container.

---

## 6. Job Cancellation (`AbortController`)

Active jobs can be cancelled mid-execution via `AbortController`:

```typescript
import { OqronManager } from "oqronkit";

const mgr = OqronManager.from(config);
await mgr.cancelJob("job-id"); // Fires AbortSignal if job is active
```

Handlers receive `ctx.signal` (an `AbortSignal`) and should check it periodically:

```typescript
handler: async (ctx) => {
  for (const chunk of chunks) {
    if (ctx.signal.aborted) return; // Respect cancellation
    await processChunk(chunk);
    await ctx.progress((chunk.index / chunks.length) * 100);
  }
}
```

When cancelled, the job is marked as `failed` with error `"Cancelled"`, the heartbeat is stopped, and the broker is acknowledged.

---

## 7. Job Ordering Strategies

Both `taskQueue()` and `Worker` support configurable ordering:

| Strategy | Behavior |
|----------|----------|
| `"fifo"` | First-In, First-Out (default) |
| `"lifo"` | Last-In, First-Out — newest jobs processed first |
| `"priority"` | Priority-weighted — lower `priority` number = processed first |

```typescript
// Per-queue:
taskQueue({ name: "urgent-tasks", strategy: "priority", handler: ... });

// Or globally:
defineConfig({ taskQueue: { strategy: "lifo" } });
```
