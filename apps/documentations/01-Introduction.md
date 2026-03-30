# Chapter 1: The Problem & The Solution

## The Problem

Historically, scheduling tasks in Node.js (via `setInterval` or `node-cron`) works perfectly on a single developer machine. However, the moment you deploy to a horizontal cluster (e.g., Kubernetes with 50 pods), **every pod runs the same `setInterval`**. If that interval sends a billing invoice, your customer gets billed 50 times.

To fix this, developers are forced to manually install massive message brokers like RabbitMQ or heavy Redis-Queue abstractions, requiring extensive DevOps configuration, manual queue declarations, and complex polling logic across thousands of lines of boilerplate.

And that only solves scheduling. What about background task processing? You need another library. Retry logic? Another. Dead letter queues? Job history? Rate limiting? Each concern brings another dependency, another API surface, and another failure point.

## The OqronKit Solution

OqronKit is a **unified background computation engine** that replaces all of these with a single, framework-agnostic package. One `import`, one configuration, and you get:

### Scheduling (Cron + Schedule)
- **Automatic Leader Election:** Only one server calculates due tasks, no matter how many pods boot, dramatically reducing CPU utilization.
- **Distributed Locks:** Even if two servers simultaneously try to execute the same job, OqronKit's lock adapter guarantees only ONE worker executes.
- **Zero-Boilerplate:** Define `.ts` files in a `/jobs` folder — OqronKit discovers, maps, and executes them out-of-the-box.

### Task Processing (TaskQueue + Queue/Worker)
- **Monolithic Mode (`taskQueue`):** Publisher and consumer live in the same process. Perfect for single-server apps and API-triggered backgrounds tasks.
- **Distributed Mode (`Queue` + `Worker`):** Publisher and consumer are completely decoupled across separate processes. Perfect for microservices and horizontal scaling.

### Enterprise Features — Built In
- Retry/backoff (fixed + exponential) with configurable delay caps
- Job history with automatic lazy pruning
- Dead letter queue hooks for failed jobs
- Progress tracking and real-time event streaming
- Crash-safe heartbeat workers with stall detection
- Mid-execution job cancellation via `AbortController` (`ctx.signal`)
- Job ordering strategies: FIFO, LIFO, and Priority
- **Job Dependencies (DAG)** — `dependsOn` parent IDs with configurable failure policy
- **Cron Clustering** — Sharded multi-region leader election for geo-distributed scheduling
- **Sandboxed Processors** — `worker_threads` isolation with resource limits for untrusted code
- DI Container (`OqronContainer`) for multi-instance and testability
- Multi-tenant environment isolation
- Typed input/output generics for full type safety
- PostgreSQL adapter with `FOR UPDATE SKIP LOCKED` atomic claiming
- Redis adapter suite (sorted sets, Lua scripts, Redlock)

## Architecture at a Glance

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
