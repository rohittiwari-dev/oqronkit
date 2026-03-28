# Changelog

All notable changes to OqronKit will be documented in this file.

## [1.0.0] - 2026-03-29

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
