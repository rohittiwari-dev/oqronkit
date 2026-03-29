# Changelog


### Patch Changes

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
