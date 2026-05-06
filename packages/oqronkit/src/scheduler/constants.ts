/**
 * Scheduler module constants.
 * Centralizes all magic numbers previously scattered across cron-engine and schedule-engine.
 *
 * These values serve as fallback defaults when the user does not provide
 * explicit configuration. They are intentionally aligned with the Zod
 * schema defaults defined in `engine/config/schema.ts`.
 */

// ── Timing Defaults ──────────────────────────────────────────────────────────

/** Default interval between scheduler tick() calls, in ms. */
export const DEFAULT_TICK_INTERVAL_MS = 1_000;

/** Default TTL for leader election locks, in ms. */
export const DEFAULT_LEADER_TTL_MS = 30_000;

/** Default lock TTL for job execution (used when `lockTtlMs` is unset). */
export const DEFAULT_LOCK_TTL_MS = 30_000;

/** Default heartbeat renewal interval for HeartbeatWorker. */
export const DEFAULT_HEARTBEAT_MS = 10_000;

/** Default lock TTL for cluster stall detection. */
export const DEFAULT_CLUSTER_STALL_TTL_MS = 50_000;

/** Grace period added to TTL before marking a job as stalled. */
export const STALL_GRACE_MS = 10_000;

/** Default StallDetector check interval, in ms. */
export const DEFAULT_STALL_DETECTOR_INTERVAL_MS = 15_000;

/** Default retry base delay when none is specified in the definition. */
export const DEFAULT_RETRY_BASE_DELAY_MS = 2_000;

// ── Shutdown ─────────────────────────────────────────────────────────────────

/** Default timeout for draining active jobs on shutdown. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000;

// ── Lag Monitor ──────────────────────────────────────────────────────────────

/** Default maximum tolerated event-loop lag before circuit trips. */
export const DEFAULT_LAG_MAX_MS = 5_000;

/** Default sampling interval for lag measurements. */
export const DEFAULT_LAG_SAMPLE_INTERVAL_MS = 1_000;

// ── Disabled Behavior (Hold) ─────────────────────────────────────────────────

/** Default maximum held jobs per schedule when `disabledBehavior` is "hold". */
export const DEFAULT_MAX_HELD_JOBS = 100;

/** Upper-bound query limit when fetching held jobs from storage. */
export const MAX_HELD_JOBS_QUERY_LIMIT = 100_000;

// ── Cluster Stall Detection ─────────────────────────────────────────────────

/** How often (in ticks) cluster stall detection runs. E.g. 10 = every 10th tick. */
export const CLUSTER_STALL_CHECK_INTERVAL_TICKS = 10;

// ── Jitter ──────────────────────────────────────────────────────────────────

/**
 * Maximum jitter factor applied to interval-based schedules (as a fraction).
 * E.g. 0.05 means up to ±5% jitter on the interval to prevent thundering herd.
 * Set to 0 to disable jitter.
 */
export const DEFAULT_INTERVAL_JITTER_FACTOR = 0.05;

// ── Misfire Threshold ────────────────────────────────────────────────────────

/**
 * Default misfire threshold in ms. If a schedule's nextRunAt is late by less
 * than this threshold, it is NOT considered a missed fire (just normal latency).
 * Mirrors Quartz's `misfireThreshold` default of 60s.
 */
export const DEFAULT_MISFIRE_THRESHOLD_MS = 60_000;
