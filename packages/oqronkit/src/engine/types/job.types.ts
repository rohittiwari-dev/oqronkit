/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  OqronKit — Unified Job Types
 *
 *  The single source of truth for all job classification, lifecycle states,
 *  retention policies, and execution records across every OqronKit module.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ── Job Classification ──────────────────────────────────────────────────────

export type JobType =
  | "task"
  | "cron"
  | "schedule"
  | "webhook"
  | "batch"
  | "workflow";

/** How a job/run was triggered */
export type JobTriggerSource =
  | "cron"
  | "schedule"
  | "api"
  | "manual"
  | "retry"
  | "flow";

export type JobStatus =
  | "waiting" // Signaled to broker, ready for worker
  | "waiting-children" // Blocked until all parent jobs complete
  | "active" // Claimed by a worker
  | "running" // Handler actively executing (used by schedule engine)
  | "completed" // Finished successfully
  | "failed" // Finished with error (retries exhausted)
  | "delayed" // Waiting for a specific timestamp or retry delay
  | "paused" // Manually stopped or held by disabled behavior
  | "stalled"; // Worker lost heartbeat — will be reclaimed

/**
 * Machine-readable reason a job entered the "paused" state.
 * Used by the dashboard to differentiate hold-by-disabled vs manual pause.
 */
export type PausedReason = "manual" | "disabled-hold";

// ── KeepJobs ────────────────────────────────────────────────────────────────

/**
 * Controls automatic job removal after completion or failure.
 *
 * @example
 * // Keep completed jobs for 1 hour, max 1000
 * removeOnComplete: { age: 3600, count: 1000 }
 *
 * // Remove immediately on completion
 * removeOnComplete: true
 *
 * // Keep only the 5 most recent
 * removeOnComplete: 5
 */
export type KeepJobs = {
  /** Max age in seconds. Jobs older than this are pruned. */
  age?: number;
  /** Max number of jobs to keep. Oldest beyond this count are pruned. */
  count?: number;
};

/** Normalized retention config — resolved from boolean | number | KeepJobs */
export type RemoveOnConfig = boolean | number | KeepJobs;

// ── Per-Job Options ─────────────────────────────────────────────────────────

export interface OqronJobOptions {
  /** Custom ID for deduplication / idempotency. If omitted, a UUID is generated. */
  jobId?: string;

  /**
   * Priority: 0 (highest) to 2_097_152 (lowest).
   * Jobs with lower numbers are processed first.
   * @default 0
   */
  priority?: number;

  /** Milliseconds to wait before this job becomes processable. */
  delay?: number;

  /**
   * Maximum number of attempts (including the first).
   * Set to 0 or 1 for no retries.
   * @default 0 (no retries)
   */
  attempts?: number;

  /**
   * Backoff strategy for retries.
   * - `fixed`: wait `delay` ms between each retry
   * - `exponential`: wait `delay * 2^(attempt-1)` ms
   */
  backoff?: {
    type: "fixed" | "exponential";
    delay: number;
  };

  /**
   * Auto-remove completed jobs.
   * - `true` → remove immediately
   * - `false` → keep forever (default)
   * - `number` → keep N most recent
   * - `KeepJobs` → keep by age/count
   */
  removeOnComplete?: RemoveOnConfig;

  /**
   * Auto-remove failed jobs (after all retries exhausted).
   * Same semantics as removeOnComplete.
   */
  removeOnFail?: RemoveOnConfig;

  /**
   * Parent job IDs this job depends on.
   * Job stays in `waiting-children` status until all parents are `completed`.
   */
  dependsOn?: string[];

  /**
   * What to do when a parent job fails.
   * - `"block"` → child stays in `waiting-children` forever (default)
   * - `"cascade-fail"` → child automatically fails
   * - `"ignore"` → child proceeds regardless of parent failure
   * @default "block"
   */
  parentFailurePolicy?: "block" | "cascade-fail" | "ignore";

  /**
   * Distributed tracing correlation ID.
   * Threaded from the caller into the job record for cross-service tracing.
   */
  correlationId?: string;
}

// ── Telemetry Sub-types ─────────────────────────────────────────────────────

/** A single structured log entry captured during job execution */
export interface JobLogEntry {
  ts: Date;
  level: string;
  msg: string;
}

/** A single state transition in the job lifecycle */
export interface JobTimelineEntry {
  ts: Date;
  from: string;
  to: string;
  reason?: string;
}

/** A single step in the execution trace (Inngest-style) */
export interface JobStepEntry {
  /** Step index (0-based) */
  idx: number;
  /** Step label from progress() or auto-generated */
  label: string;
  /** When this step started */
  startedAt: Date;
  /** When this step ended */
  finishedAt?: Date;
  /** Duration in ms */
  durationMs?: number;
  /** Status */
  status: "running" | "completed" | "failed";
  /** Output/return value */
  output?: any;
  /** Error if step failed */
  error?: string;
}

// ── Flow Jobs (DAG) ─────────────────────────────────────────────────────────

export interface FlowJobNode<T = any> {
  name: string;
  queueName: string;
  data: T;
  opts?: OqronJobOptions;
  children?: FlowJobNode<any>[];
}

// ── Unified OqronJob Record ─────────────────────────────────────────────────

/**
 * The single source of truth for every background operation in OqronKit.
 *
 * Every module (cron, schedule, queue) writes this exact format to the
 * unified `jobs` namespace in Storage, ensuring a single dashboard/API.
 */
export interface OqronJob<T = any, R = any> {
  /** Unique job identifier (UUID or custom jobId) */
  id: string;

  /** Discriminator for the module that created this job */
  type: JobType;

  /** Queue/module namespace this job belongs to */
  queueName: string;

  /** Current lifecycle state */
  status: JobStatus;

  /** Which module definition created this job (e.g. "email-queue", "daily-report") */
  moduleName?: string;

  // ── Payloads ────────────────────────────────────────────────────────────

  /** The input data/payload */
  data: T;

  /** Options that were used when creating this job */
  opts: OqronJobOptions;

  // ── Execution State ─────────────────────────────────────────────────────

  /**
   * Number of attempts completed (success or failure).
   */
  attemptMade: number;

  /**
   * Progress as a number 0-100.
   */
  progressPercent: number;

  /** Human-readable progress label */
  progressLabel?: string;

  /** ID of the worker/node that is processing this job */
  workerId?: string;

  /** Number of times this job has stalled (worker lost heartbeat) */
  stalledCount?: number;

  // ── Results ─────────────────────────────────────────────────────────────

  /** The value returned by the handler on success */
  returnValue?: R;

  /** Error message on failure */
  error?: string;

  /** Error stack traces (array of strings) */
  stacktrace?: string[];

  // ── Relationships ───────────────────────────────────────────────────────

  /** Parent job ID (for flow/DAG) */
  parentId?: string;

  /** IDs of child jobs that depend on this job */
  childrenIds?: string[];

  /** Linked cron/schedule definition name */
  scheduleId?: string;

  /** Original job ID when this is a retry (memoization link) */
  retriedFromId?: string;

  // ── Metadata ────────────────────────────────────────────────────────────

  /** Tags for categorization and filtering */
  tags: string[];

  /** Environment that created this job (for isolation) */
  environment?: string;

  /** Project namespace */
  project?: string;

  /**
   * Machine-readable reason why this job is in "paused" status.
   * - `"manual"` — paused by admin/API
   * - `"disabled-hold"` — held because the module instance was disabled
   */
  pausedReason?: PausedReason;

  // ── Enhanced Execution Telemetry ──────────────────────────────────────

  /** Pre-computed execution duration in ms (finishedAt - startedAt) */
  durationMs?: number;

  /** When the job entered the queue (before any processing delay) */
  queuedAt?: Date;

  /** When the worker actually picked up the job */
  processedOn?: Date;

  /** Total allowed attempts (including first run) */
  maxAttempts?: number;

  /** Reason for last retry (if retried) */
  retryReason?: string;

  /** Time spent waiting in the queue before processing started (in ms) */
  latencyMs?: number;

  /** Peak memory usage during execution (in MB) */
  memoryUsageMb?: number;

  /** How this run was triggered */
  triggeredBy?: JobTriggerSource;

  /** Distributed tracing correlation ID */
  correlationId?: string;

  /** Structured execution logs (collected via ctx.log) */
  logs?: JobLogEntry[];

  /** State transition timeline (capped at configurable max, default 20) */
  timeline?: JobTimelineEntry[];

  /** Step-level execution trace (Inngest-style step waterfall) */
  steps?: JobStepEntry[];

  // ── Timestamps ──────────────────────────────────────────────────────────

  /** When the job was created */
  createdAt: Date;

  /** When a worker started processing */
  startedAt?: Date;

  /** When the handler completed or failed */
  finishedAt?: Date;

  /** Scheduled execution time (for delayed/scheduled jobs) */
  runAt?: Date;
}

// ── Filters & Stats ─────────────────────────────────────────────────────────

export interface JobFilter {
  type?: JobType;
  status?: JobStatus;
  queueName?: string;
  scheduleId?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
}

export interface SystemStats {
  project: string;
  env: string;
  uptime: number;
  counts: {
    jobs: Record<JobStatus, number>;
    schedules: number;
    activeWorkers: number;
  };
}
