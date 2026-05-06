# Changelog

All notable changes to OqronKit will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.2] — 2026-05-06

### Fixed

#### Execution Ownership
- **Container claimBlocking forwarding** — `OqronContainer`'s isolated broker now correctly forwards the optional `claimBlocking` method, preventing CPU-burning polling fallback.
- **Stall handler cleanup** — When the stall detector fires, the stuck handler's `AbortController` is now aborted and its concurrency slot is released, preventing permanent "zombie" capacity loss.
- **Worker stall filter** — Stall detector now includes inactive heartbeats in its scan, ensuring jobs with failed lock renewals are still recovered.
- **Batch cancellation check** — Batch finalization now verifies `signal.aborted` before accepting "fulfilled" status, preventing cancelled-but-completed race conditions.

#### Stuck Job Prevention
- **Webhook held-job release** — `resumeDispatcher()` now releases jobs enqueued with `disabledBehavior: "hold"` while the dispatcher was paused.
- **Queue resume dependency check** — `resumeQueue()` now verifies `dependsOn` dependencies before promoting held jobs, routing unmet deps to `"waiting-children"` instead of `"waiting"`.
- **Manager loop safety cap** — The held-job release loop in `OqronManager` is now capped at 20 batches (2000 jobs) to prevent infinite loops on storage errors.
- **Retry/rerun priority passthrough** — `retryJob()` and `rerunJob()` now correctly pass `opts.priority` to `Broker.publish()`.

#### Correctness & Consistency
- **Retry `runAt` timestamp** — Delayed retries now set `job.runAt`, making retry schedules visible to reconciliation and dashboards.
- **Default priority persistence** — Queue-level `config.priority` is now persisted on `job.opts.priority` at creation time, ensuring retries and stall recovery preserve priority.
- **Cancel writes tombstone** — `cancelJob()` now writes a `"cancelled"` tombstone with `finishedAt` and timeline entry instead of deleting, preserving audit history. Retention policies handle cleanup.
- **Schedule `run-all` missed fire** — `missedFire: "run-all"` now correctly enumerates all missed occurrences via `MissedFireHandler` instead of firing only once.
- **Cron type stamp** — Same-version upserts now include `moduleType`, preventing namespace corruption in manager lookups.

#### Hardening & Polish
- **`logger: false` inversion** — Setting `logger: false` now correctly disables all logging.
- **`stop()` timeout leak** — Shutdown timeout handle is now stored, `.unref()`'d, and cleared in `finally`.
- **Signal handler binding** — Graceful shutdown signals now bind to `OqronKit.stop()` explicitly, preventing `this` binding errors.
- **Webhook cancel aborts HTTP** — `deliverWebhook` now accepts an external `AbortSignal`, allowing immediate cancellation of in-flight HTTP requests.
- **MemoryStore falsey values** — `MemoryStore.get` now correctly handles falsey values (`0`, `false`, `""`).
- **MemoryBroker `extendLock` O(1)** — Added optional `brokerName` parameter for direct key lookup instead of O(n) scan.
- **Redis `claimBlocking` pause re-check** — Re-checks pause state after `BLPOP` returns, pushing the item back if paused during the blocking wait.
- **UI auth validation** — Zod schema now rejects partial auth config (only username or only password).
- **Webhook resend clears delay** — Resend clones now clear `runAt` and `opts.delay` for immediate dispatch.

## [0.0.1] — 2026-03-30

### Added
- Initial release with 12 enterprise modules: Task Queue, Distributed Worker, Scheduler, Rate Limiter, Webhook, Batch, Workflow (DAG), Stack, Saga, Pipeline, PubSub, Cache, Ingest.
- Adapter-driven architecture with Memory, Redis, and Postgres adapters.
- Crash-safe execution via heartbeat locks and stall detection.
- Built-in Admin UI dashboard with auth support.
- 741-test suite with full module coverage.
