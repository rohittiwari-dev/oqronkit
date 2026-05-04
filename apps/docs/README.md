# OqronKit

**OqronKit v1 Enterprise Release** — An industry-grade, crash-safe, and framework-agnostic backend orchestration and distributed processing engine for Node.js.

## Overview

OqronKit is a powerful engine designed to build and scale background computation architectures. Whether you are running monolithic in-memory setups or massively scaled decoupled microservices across Redis or Postgres, OqronKit provides the structural guarantees needed for reliable task execution.

## Key Features

- **Native Horizontal Scaling & Microservices:** Seamlessly transition from an In-Memory adapter to Redis/Postgres adapters to distribute workloads.
- **Server Independence:** Strict decoupling between Senders (API Nodes) and Processors (Worker Nodes).
- **Adapter-Driven Architecture:** All persistence interactions route through `IOqronAdapter`, `ILockAdapter`, and `IQueueAdapter`.
- **Crash-Safety via Heartbeat Locks:** Built-in `StallDetector` and heartbeat intervals ensure that jobs from crashed workers are automatically reclaimed and retried.
- **Strict Idempotency:** Guaranteed state consistency before and immediately after job/step completions.

## Enterprise Modules

OqronKit provides a comprehensive suite of 12 distributed computation modules:

1. **Task Queue:** Unified monolithic queue.
2. **Distributed Worker:** Decoupled `Queue` pushing and `Worker` polling.
3. **Batch:** Accumulator buffering (`maxSize` / `maxWaitMs`).
4. **RateLimit:** Sliding-window distributed limits.
5. **Workflow (DAG):** Complex dependency grids.
6. **Stack:** LIFO rollback migration sequences.
7. **Saga:** Distributed microservice transactions with compensations.
8. **Pipeline:** Streaming ETL with backpressure.
9. **Webhook:** Webhook dispatch with DLQ and cryptographic signing.
10. **PubSub:** Durable topics and fan-out consumer groups.
11. **Cache:** Stampede-protected hierarchical memory tiers.
12. **Ingest:** Ultra-fast event-driven stateful execution (`step.run`, `step.sleep`, `step.invoke`).

## Documentation

Please visit our [Documentation](https://oqronkit.dev/docs) for full guides, API references, and architectural patterns.

## License

MIT
