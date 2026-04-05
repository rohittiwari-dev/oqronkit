# Changelog


### Patch Changes

- ## 0.0.1-alpha.5

  ### New Features

  - **Disabled Queue/Schedule Handling** — Added configurable `disabled` behavior for schedules and queues. Includes `maxHeldJobs` config and `disabledold` handling to efficiently prune the oldest held jobs when an instance is disabled.
  - **Admin Module & Isolation** — Added admin module and instance handlers with improved isolation prefixing.
  - **Trigger Auto-Discovery** — Added trigger auto-discovery support with new configuration options. Removed unused trigger modules from the backend.

  ### Fixes & Improvements

  - Refined `nextRun` calculation and optimized job pruning logic.
  - Enhanced robustness of memory lock/store handling and cron compatibility.
  - General housekeeping including whitespace fixes, import cleanups, and test mock field renaming.

- ## 0.0.1-alpha.4

  ### New Features

  - **Job Dependencies (DAG)** — Jobs can declare `dependsOn: [parentId]` to wait for parent completion before processing. Children stay in `"waiting-children"` status until all parents finish. Three configurable failure policies: `"block"` (default), `"cascade-fail"`, and `"ignore"`.
  - **Cron Clustering** — `ShardedLeaderElection` enables multi-region geo-distributed scheduling. Schedule names are MD5-hashed to shard indices; each region claims a subset of shards. If a region goes down, surviving nodes recover the orphaned shard locks after TTL expiry.
  - **Sandboxed Processors** — `SandboxWorker` provides `worker_threads` isolation with enforced `resourceLimits` (memory caps) and execution timeouts. Untrusted code runs in a separate V8 isolate — OOM crashes the sandbox thread, not the host process.
  - **Full DI Container Migration** — Replaced all remaining global adapter imports (`Storage`, `Broker`, `Lock`) with explicit `OqronContainer` injection across `ScheduleEngine`, `Queue`, `QueueEvents`, and `TaskQueue`.

  ### Environment Isolation Hardening

  - **Adapter prefix now includes `environment`** — Redis keys changed from `{project}:store:...` to `{project}:{environment}:store:...`. Two deployments sharing the same Redis with different environments are now physically isolated at the key level.
  - **Lock and leader keys namespaced** — Leader election keys (`oqron:scheduler:leader`) and execution lock keys (`oqron:run:{name}`) now include `{project}:{environment}`, preventing cross-environment leader theft and lock collisions.
  - **Job records stamped with environment** — `taskQueue().add()` and `Queue.add()` now stamp `environment` and `project` from `OqronContainer.config` onto every job record, closing the gap where engine guards were silently bypassed for unstamped jobs.
  - **Environment-mismatched jobs nack'd** — Workers now `broker.nack()` jobs from the wrong environment back to the queue instead of silently dropping them.
  - **`OqronContainer` now holds `OqronConfig`** — Config is injected via constructor (Option A) for multi-instance support. Accessible via `container.config`.

  ### Tests

  - **275 tests across 29 files** (up from 253 tests across 26 files)
  - New test suites: `job-dependencies.test.ts` (10 tests), `sharded-leader.test.ts` (7 tests), `sandbox.test.ts` (5 tests)
  - A+ maturity rating across all modules

  ### Documentation

  - `02-Core-Concepts.md` — Added §8 Job Dependencies (DAG), §9 Cron Clustering, §10 Sandboxed Processors
  - `08-Configuration-Reference.md` — Added `clustering` and `sandbox` config schemas
  - `09-Real-World-Examples.md` — Added ETL DAG pipeline, multi-region cron, sandboxed code runner examples
  - `10-Roadmap-and-Future.md` — Moved advanced patterns from "Future" to "Current State"
  - New backend example: `apps/backend/src/jobs/advanced-patterns.ts`

- ## 0.0.1-alpha.3

  ### New Features

  - **DI Container** (`OqronContainer`) — replaces module globals with injectable, multi-instance-ready container. Backward-compatible Proxy shims ensure zero breaking changes.
  - **Job Cancellation** — `AbortController`-based mid-execution cancel. Handlers receive `ctx.signal` (AbortSignal) and can check `ctx.signal.aborted` periodically. `OqronManager.cancelJob()` aborts active jobs, stops heartbeats, and acks the broker.
  - **Job Ordering Strategies** — FIFO, LIFO, and Priority strategies configurable per-queue or globally via `strategy` option.
  - **PostgreSQL Adapter** — `PostgresStore` (JSONB+GIN), `PostgresBroker` (`FOR UPDATE SKIP LOCKED`), `PostgresLock` (advisory locks).
  - **Redis Adapter Suite** — `RedisStore`, `RedisBroker` (sorted sets + Lua), `RedisLock` (Redlock).

  ### Infrastructure

  - `IOqronModule.cancelActiveJob()` — new optional method for engines to support mid-execution cancellation
  - `TaskJobContext.signal` — AbortSignal passed to all taskQueue handlers
  - `OqronContainer.init()` / `.get()` / `.reset()` / `.tryGet()` lifecycle
  - `core.ts` exports `Storage`, `Broker`, `Lock` as Proxy shims (backward-compatible)
  - Updated all engine constructors to accept optional `OqronContainer` for multi-instance support

  ### Tests

  - **253 tests across 26 files** (up from 163 tests across 20 files)
  - New test suites: `container.test.ts` (14 tests), `cancel-job.test.ts` (13 tests)
  - A+ maturity rating across all 16 modules

  ### Documentation

  - Updated all 10 documentation chapters for v1 features
  - Updated backend example with `ctx.signal`, `strategy`, and cancel endpoint
  - Complete README rewrite with v1 feature showcase

All notable changes to OqronKit will be documented in this file.

## [0.0.1-alpha.1] - 2026-03-29

### Added

- **Core Scheduling:** Cron expressions, interval-based, and `every` syntax scheduling
- **Schedule Engine:** One-shot (`runAt`/`runAfter`), recurring, and RRule-based scheduling
- **Database Adapters:** Memory, SQLite (`better-sqlite3`), PostgreSQL (`pg`), Redis (`ioredis`)
- **Lock Adapters:** Memory, SQLite-backed, PostgreSQL-backed, Redis-backed (`SET NX PX` + Lua)
- **Custom Adapter Factories:** `createDbAdapter()` and `createLockAdapter()` for custom backends
- **Multi-Tenant Isolation:** `NamespacedOqronAdapter` with `project:environment:` prefixing
- **Graceful Shutdown:** `Promise.allSettled()` drain with configurable timeout before lock release
- **Pause/Resume API:** `OqronKit.pause()` / `.resume()` for admin kill-switch without redeployment
- **Event Loop Protection:** `LagMonitor` circuit breaker (configurable threshold)
- **Concurrency Rate Limiting:** `maxConcurrent` per schedule definition
- **Stall Detection:** `StallDetector` auto-aborts orphaned jobs whose locks expired
- **Leader Election:** Only one node per cluster runs initialization and missed-fire recovery
- **Prometheus Observability:** `OqronKit.getMetrics()` with counters, gauges, and duration summaries
- **EventBus:** `OqronEventBus` with `job:start`, `job:success`, `job:fail` events
- **Server Integration:** Express router and Fastify plugin for `/health`, `/events` endpoints
- **Auto-Discovery:** Recursive `jobsDir` scanning for `.ts`/`.js` job definitions
- **Handler Timeout:** `AbortController` signal propagation with configurable per-job timeout
- **Retry Strategy:** Exponential and fixed backoff with configurable max attempts
- **Missed Fire Recovery:** `skip`, `run-once`, and `run-all` policies
- **Job Tags:** Tags on schedule definitions and execution history for audit filtering
- **Optional Peer Dependencies:** `better-sqlite3`, `pg`, and `ioredis` are optional — install only what you need

### Changed

- Renamed `ChronoError` → `OqronError` (backwards-compatible alias retained)
- Renamed `chrono_locks` table → `oqron_locks`
- Renamed `CHRONO_ENV` environment variable → `OQRON_ENV`
