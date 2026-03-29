# Chapter 10: Roadmap & Future Expansion

## Current State (v1.0)

OqronKit v1.0 is a production-grade, enterprise-ready distributed processing engine with comprehensive infrastructure:

### Core Modules — All Production-Ready

| Module | Status | Description |
|--------|--------|-------------|
| **Cron** | ✅ Stable | Time-driven global sweeps with leader election |
| **Schedule** | ✅ Stable | Data-driven parameterized tasks with RRULE support |
| **TaskQueue** | ✅ Stable | Monolithic background processing with retry/DLQ/cancel |
| **Queue/Worker** | ✅ Stable | Distributed producer-consumer with rate limiting |

### Infrastructure — Completed

- ✅ **Multi-Adapter Architecture** — Memory, Redis, and PostgreSQL
- ✅ **DI Container** (`OqronContainer`) — Full injection across all engines, no Proxy shim dependencies
- ✅ **Job Cancellation** — `AbortController`-based mid-execution cancel via `ctx.signal`
- ✅ **Job Dependencies (DAG)** — `dependsOn` parent IDs with configurable failure policy
- ✅ **Cron Clustering** — Sharded multi-region leader election for geo-distributed scheduling
- ✅ **Sandboxed Processors** — `worker_threads` isolation with resource limits for untrusted code
- ✅ **Job Ordering Strategies** — FIFO, LIFO, and Priority across all brokers
- ✅ **PostgreSQL Adapter** — `FOR UPDATE SKIP LOCKED` atomic claiming, JSONB+GIN storage, advisory locks
- ✅ **Redis Adapter Suite** — Sorted sets, Lua scripts, Redlock
- ✅ **Unified `OqronJob` record format** across all modules
- ✅ **Lazy retention pruning** (count-based and age-based)
- ✅ **Fixed + exponential backoff strategies**
- ✅ **Dead letter queue hooks**
- ✅ **Environment isolation** — `${project}:${environment}` namespacing
- ✅ **Graceful shutdown** with configurable timeout and abort
- ✅ **`OqronEventBus` + `QueueEvents`** for cross-cutting telemetry
- ✅ **TelemetryManager** — Prometheus-compatible metrics (p50/p95/p99 quantiles)
- ✅ **Server/Admin API** — Health, events, trigger, queue management, job CRUD
- ✅ **Stall Detection** — Automatic recovery of crashed worker jobs
- ✅ **Leader Election** — Heartbeat-based master poller for cron/schedule modules
- ✅ **Universal Adapter Contract Tests** — 36 tests ensuring consistency across Memory/Redis/PG

### Test Coverage

| Metric | Value |
|--------|:-----:|
| Test Files | **29** |
| Tests Passing | **275** |
| Type Errors | **0** |
| Module Grades | **A+ across all 16 modules** |

---

## 🚀 Next Phase: Enterprise Modules (v1.x)

The v1.x release cycle will add 8 additional enterprise modules:

| Module | Purpose | Priority |
|--------|---------|:--------:|
| **Workflow (DAG)** | Complex dependency graphs with `FlowProducer`-style job trees | 🔴 High |
| **Ingest** | Event-driven functions mimicking Inngest (`step.run`, `step.sleep`, `step.invoke`) | 🔴 High |
| **Batch** | Accumulator buffering with `maxSize` / `maxWaitMs` triggers | 🟡 Medium |
| **RateLimit** | Sliding-window distributed rate limiting | 🟡 Medium |
| **Saga** | Distributed microservice transactions with compensation chains | 🟡 Medium |
| **Webhook** | Outbound webhook dispatch with DLQ and cryptographic signing | 🟡 Medium |
| **PubSub** | Durable topics and fan-out consumer groups | 🟡 Medium |
| **Pipeline** | Streaming ETL with backpressure | 🟢 Low |

---

## 💡 Future Ideation (Post-v1.x)

### OqronKit Dashboard (`@oqronkit/ui`)
A standalone Next.js server-rendered dashboard to:
- Visualize job states across all queues
- Manually trigger, pause, cancel, and retry jobs
- Drill into job payloads, stacktraces, and execution history
- Real-time progress streaming for active jobs
- Prometheus/Grafana integration

### External Broker Adapters
- **Kafka** — For ultra-high-throughput event streaming
- **RabbitMQ** — For advanced routing and exchange topologies
- **AWS SQS** — For serverless-native deployments

---

## Contributing

OqronKit follows an adapter-driven architecture. All contributions should respect the separation:

1. **Engine files** in `src/<module>/` — pure logic, no database calls
2. **Adapter implementations** in `src/engine/<adapter>/` — adapter-specific code
3. **Type definitions** in `src/<module>/types.ts` — interfaces and config shapes
4. **Tests** in `test/<module>/` — Vitest, covering crash recovery and edge cases
5. **DI Container** — new engines should accept `OqronContainer` via constructor injection

When adding a new module, follow the existing directory structure:
```
src/<module>/
  ├── types.ts              # Interfaces and config types
  ├── define-<module>.ts    # User-facing factory function
  ├── <module>-engine.ts    # Engine implementing IOqronModule
  └── registry.ts           # Internal registration store
```
