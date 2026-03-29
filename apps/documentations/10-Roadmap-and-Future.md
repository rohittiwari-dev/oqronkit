# Chapter 10: Roadmap & Future Expansion

## Current State (v0.x)

OqronKit v0.x has established the core foundation with 4 production-ready modules:

| Module | Status | Description |
|--------|--------|-------------|
| **Cron** | ✅ Stable | Time-driven global sweeps with leader election |
| **Schedule** | ✅ Stable | Data-driven parameterized tasks with RRULE support |
| **TaskQueue** | ✅ Stable | Monolithic background processing with retry/DLQ |
| **Queue/Worker** | ✅ Stable | Distributed producer-consumer with rate limiting |

Shared infrastructure operational:
- ✅ Unified `OqronJob` record format across all modules
- ✅ Lazy retention pruning (count-based and age-based)
- ✅ Fixed + exponential backoff strategies
- ✅ Dead letter queue hooks
- ✅ Environment isolation
- ✅ Graceful shutdown with configurable timeout
- ✅ `OqronEventBus` for cross-cutting telemetry

---

## 🚀 Priority Implementations (v1.0)

### 1. PostgreSQL Adapter
Utilizing `FOR UPDATE SKIP LOCKED` for native row-level locking, eliminating the need for a separate Redis lock cluster. This is the highest-priority production adapter.

### 2. Redis Adapter Suite
- **RedisLockAdapter** via Redlock for multi-region distributed locking
- **RedisBrokerAdapter** via Redis Streams for durable message brokering
- **RedisStorageAdapter** for high-speed ephemeral job storage

### 3. Remaining Enterprise Modules
The v1 roadmap includes 8 additional modules beyond the current 4:

| Module | Purpose |
|--------|---------|
| **Batch** | Accumulator buffering with `maxSize` / `maxWaitMs` triggers |
| **RateLimit** | Sliding-window distributed rate limiting |
| **Workflow (DAG)** | Complex dependency graphs with `FlowProducer`-style job trees |
| **Stack** | LIFO rollback sequences for migrations |
| **Saga** | Distributed microservice transactions with compensation chains |
| **Pipeline** | Streaming ETL with backpressure |
| **Webhook** | Outbound webhook dispatch with DLQ and cryptographic signing |
| **PubSub** | Durable topics and fan-out consumer groups |

### 4. Deep Telemetry Integration
- Prometheus metrics export (`oqronkit_jobs_active`, `oqronkit_execution_lag_ms`, `oqronkit_duration_ms`)
- OpenTelemetry span propagation for distributed tracing across Queue → Worker boundaries
- Express middleware for `/api/oqron/metrics` endpoint

---

## 💡 Future Ideation (Post-v1)

### OqronKit Dashboard (`@oqronkit/ui`)
A standalone Next.js server-rendered dashboard to:
- Visualize job states across all queues
- Manually trigger, pause, and retry jobs
- Drill into job payloads, stacktraces, and execution history
- Real-time progress streaming for active jobs

### External Broker Adapters
- **Kafka** — For ultra-high-throughput event streaming
- **RabbitMQ** — For advanced routing and exchange topologies
- **AWS SQS** — For serverless-native deployments

### Advanced Patterns
- **Job Priorities** — Weighted priority queues with O(log n) insertion
- **Job Dependencies** — `waitForJob("parent-id")` before processing
- **Cron Clustering** — Multiple cron leaders across regions for geo-distributed scheduling
- **Sandboxed Processors** — Worker thread isolation for untrusted handler code

---

## Contributing

OqronKit follows an adapter-driven architecture. All contributions should respect the separation:

1. **Engine files** in `src/<module>/` — pure logic, no database calls
2. **Adapter implementations** in `src/<module>/<module>-adapters/` — database-specific code
3. **Type definitions** in `src/<module>/types.ts` — interfaces and config shapes
4. **Tests** in `test/<module>/` — Vitest, covering crash recovery and edge cases

When adding a new module, follow the existing directory structure:
```
src/<module>/
  ├── types.ts              # Interfaces and config types
  ├── define-<module>.ts    # User-facing factory function
  ├── <module>-engine.ts    # Engine implementing IOqronModule
  └── registry.ts           # Internal registration store
```
