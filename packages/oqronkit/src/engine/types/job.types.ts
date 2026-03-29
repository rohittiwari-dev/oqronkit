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
  | "workflow"
  | "saga";

export type JobStatus =
  | "waiting" // Signaled to broker, ready for worker
  | "active" // Claimed by a worker
  | "completed" // Finished successfully
  | "failed" // Finished with error (retries exhausted)
  | "delayed" // Waiting for a specific timestamp or retry delay
  | "paused" // Manually stopped
  | "stalled"; // Worker lost heartbeat — will be reclaimed

// ── Industrygrade-Compatible KeepJobs ──────────────────────────────────────────────

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
 * Aligns with Industrygrade's Job class properties for maximum compatibility.
 *
 * Every module (cron, schedule, taskQueue, worker) writes this
 * exact format to Storage, ensuring a unified dashboard/API.
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

  /** Linked cron/schedule definition name */
  scheduleId?: string;

  // ── Metadata ────────────────────────────────────────────────────────────

  /** Tags for categorization and filtering */
  tags: string[];

  /** Environment that created this job (for isolation) */
  environment?: string;

  /** Project namespace */
  project?: string;

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
