# Changelog

## [0.0.3] — 2026-05-07

### Added

- This release introduces three highly anticipated core modules — **Cache**, **Batch**, and **PubSub** — that transform the engine from a standard job queue into a full-fledged distributed application framework.

  This release also includes critical stability fixes for graceful shutdown and webhook throttling.

  ### Major Features

  #### 1. Cache Module

  A highly resilient, multi-tiered caching engine designed to prevent database meltdowns during traffic spikes.

  - **Stampede Protection:** Built-in `clusterLock` prevents cache stampedes (dogpiling) using our distributed `ILockAdapter`. Only one node fetches the fresh data; all others wait seamlessly.
  - **Stale-While-Revalidate (SWR):** Instantly serve slightly stale data while seamlessly refreshing it in the background via the background queue.
  - **Negative Caching:** Cache `null` results to prevent DDoS attacks against non-existent records (e.g., 404s).
  - **Tag-based Invalidation:** Tag cache entries (e.g., `user:123`, `tenant:abc`) and purge them globally across the entire cluster using the `IBrokerEngine` broadcast system.
  - **Batch Fetching (`fetcherMany`):** Built-in DataLoader patterns to eliminate N+1 queries.

  #### 2. Batch Module

  Accumulator buffering designed for massive data ingestion, email dispatching, and high-throughput write buffering.

  - **Buffer Flush Triggers:** Trigger batch processing automatically based on `maxSize` (count) or `maxWaitMs` (time threshold).
  - **Persistent Buffer Locks:** Buffers are crash-safe. If a node crashes mid-flush, the buffered items are reclaimed and flushed by a healthy node.
  - **Admin APIs:** Powerful administrative control to `pause()`, `resume()`, or manually `flush()` buffers.
  - **Progress Tracking:** Fine-grained event-driven progress reporting for long-running batch jobs.

  #### 3. PubSub Module

  Durable publish/subscribe messaging built natively on top of the OqronKit adapter layer.

  - **Durable Topics & Consumer Groups:** Fully durable fan-out messaging. Each subscriber group gets its own independent offset tracking.
  - **At-Least-Once Delivery:** Uses the same robust heartbeat locking system as our standard worker queues.
  - **Message Filtering:** Server-side message filtering at the broker level to reduce unnecessary handler invocations.
  - **Replay:** Rewind time! Replay messages for a consumer group from a specific offset or timestamp.
  - **Dead Letter Queues:** Built-in DLQ for unprocessable pub/sub messages with automated exponential backoff retries.

### Fixed

  - **Custom Adapter Factory Support:** You can now inject fully custom `Storage`, `Broker`, and `Lock` adapters natively through the configuration object.
  - **Webhook Throttling:** Added per-dispatcher throttling caps to prevent outbound webhook delivery from overwhelming third-party APIs.
  - **Graceful Shutdown & Stalled Jobs:** Major improvements to the shutdown lifecycle. Stalled jobs are now aborted safely and cleanly recovered by the cross-node stall scanner.
  - **Cancel Jobs:** Fixed issues where active jobs could not be cleanly cancelled mid-execution.
  - **Timer Leaks:** Cleaned up residual polling timers that were preventing the Node.js event loop from exiting gracefully on shutdown.

  ### Documentation Overhaul

  The documentation portal has been completely modernized!

  - **New UI:** High-energy, Expo-inspired design with a warm color palette.
  - **Consolidated Source of Truth:** Removed legacy `apps/documentations` directory and centralized everything into the modern Fumadocs `apps/docs` portal.
  - **New Guides:** Added comprehensive, copy-paste-ready real-world examples for caching (N+1 solutions, Sessions, GitHub API fetching) and batching.


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

- Initial release with 12 core modules: Task Queue, Distributed Worker, Scheduler, Rate Limiter, Webhook, Batch, Workflow (DAG), Stack, Saga, Pipeline, PubSub, Cache, Ingest.
- Adapter-driven architecture with Memory, Redis, and Postgres adapters.
- Crash-safe execution via heartbeat locks and stall detection.
- Built-in Admin UI dashboard with auth support.
- 741-test suite with full module coverage.
