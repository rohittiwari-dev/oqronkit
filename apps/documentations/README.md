# OqronKit Documentation

Start with the Introduction and work through each chapter sequentially:

1. [Introduction — The Problem & The Solution](./01-Introduction.md)
2. [Core Concepts](./02-Core-Concepts.md) — Modules, Leader Election, Crash Safety, DI, Cancellation, Ordering, **Job Dependencies (DAG)**, **Cron Clustering**, **Sandboxed Processors**
3. [Module Guide: Cron & Schedule](./03-Module-Guide-Cron-and-Schedule.md)
4. [Module Guide: TaskQueue](./04-Module-Guide-TaskQueue.md)
5. [Module Guide: Queue + Worker](./05-Module-Guide-Queue-Worker.md)
6. [TaskQueue vs Queue/Worker](./06-TaskQueue-vs-Queue-Worker.md)
7. [Job Lifecycle & Retention](./07-Job-Lifecycle-and-Retention.md)
8. [Configuration Reference](./08-Configuration-Reference.md) — All options including `clustering` and `sandbox`
9. [Real-World Examples](./09-Real-World-Examples.md) — 10 production-grade examples including ETL DAGs, multi-region cron, and sandboxed code runners
10. [Roadmap & Future](./10-Roadmap-and-Future.md)

## Backend Example App

Working examples in [`apps/backend/src/jobs/`](../backend/src/jobs/):

| File | Demonstrates |
|------|-------------|
| `crons.ts` | Cron definitions with overlap, timeouts, and progress |
| `scheduler.ts` | Data-driven parameterized schedules |
| `task-queues.ts` | Monolithic task queues with typed I/O |
| `distributed-workers.ts` | Queue + Worker decoupled architecture |
| `advanced-patterns.ts` | **NEW** — Job Dependencies (DAG), Cron Clustering, Sandboxed Processors |
