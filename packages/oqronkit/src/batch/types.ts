/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  OqronKit — Batch Module Types
 *
 *  Defines the configuration, context, payload, and public API interfaces
 *  for the producer-side batch accumulator module.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import type { DisabledBehavior } from "../engine/types/config.types.js";
import type { RetryConfig } from "../engine/types/cron.types.js";
import type {
  OqronJob,
  RemoveOnConfig,
} from "../engine/types/job.types.js";

// ── Batch Configuration ─────────────────────────────────────────────────────

export interface BatchConfig<T = any, R = any> {
  /** Unique identifier for this batch definition */
  name: string;

  /** Schema version — bump to trigger config migration */
  version?: number;

  /** Tags for categorization and dashboard filtering */
  tags?: string[];

  // ── Flush triggers (OR logic — whichever comes first) ──────────────────

  /** Flush when N items are buffered */
  maxSize: number;

  /** Flush after N ms since first item in buffer */
  maxWaitMs: number;

  // ── Grouping & Deduplication ───────────────────────────────────────────

  /**
   * Partition items into separate buffers by group key.
   * Each group flushes independently. Useful for multi-tenant isolation.
   *
   * @example
   * groupBy: (item) => item.tenantId
   */
  groupBy?: (item: T) => string;

  /**
   * Content-based deduplication within a single buffer window.
   * Items with the same dedup key are silently skipped.
   *
   * @example
   * deduplicateBy: (item) => `${item.userId}:${item.type}`
   */
  deduplicateBy?: (item: T) => string;

  // ── Handler ────────────────────────────────────────────────────────────

  /**
   * The batch processing function. Receives the accumulated items
   * when flush conditions are met.
   */
  handler: (ctx: BatchJobContext<T>) => Promise<R>;

  // ── Execution ──────────────────────────────────────────────────────────

  /** Max parallel batch jobs for this definition. @default 1 */
  concurrency?: number;

  /** Enable heartbeat crash-safety for batch job processing. @default true */
  guaranteedWorker?: boolean;

  /** Heartbeat renewal interval in ms. @default 5000 */
  heartbeatMs?: number;

  /** Lock TTL in ms for crash recovery. @default 30000 */
  lockTtlMs?: number;

  /** Handler execution timeout in ms */
  timeout?: number;

  // ── Throttle ───────────────────────────────────────────────────────────

  /**
   * Caps the flush rate per time window.
   * @example throttle: { max: 10, duration: 60_000 } — max 10 flushes per minute
   */
  throttle?: { max: number; duration: number };

  // ── Retry ──────────────────────────────────────────────────────────────

  /** Retry policy for failed batch handlers */
  retries?: RetryConfig;

  // ── Dead Letter Queue ──────────────────────────────────────────────────

  deadLetter?: {
    enabled?: boolean;
    onDead?: (job: OqronJob<BatchPayload<T>>) => Promise<void>;
  };

  // ── Lifecycle Hooks ────────────────────────────────────────────────────

  hooks?: {
    /**
     * Called before items are flushed. Can filter or transform items.
     * Return the modified array — items removed here are discarded.
     */
    beforeFlush?: (
      items: T[],
      groupKey?: string,
    ) => Promise<T[]> | T[];

    /** Called after the batch handler completes successfully */
    onSuccess?: (
      job: OqronJob<BatchPayload<T>>,
      result: R,
    ) => Promise<void> | void;

    /** Called after the batch handler fails (before retry) */
    onFail?: (
      job: OqronJob<BatchPayload<T>>,
      error: Error,
    ) => Promise<void> | void;
  };

  // ── Persistence & Backpressure ─────────────────────────────────────────

  /**
   * Persist buffers to storage adapter for crash safety.
   * Set `false` for ultra-high-throughput in-memory-only buffering.
   * @default true
   */
  persist?: boolean;

  /**
   * Flush remaining buffered items on graceful shutdown.
   * @default true
   */
  flushOnShutdown?: boolean;

  /**
   * Max number of unflushed batch jobs before backpressure kicks in.
   * When reached, new `add()` calls are rejected until pending batches drain.
   * @default 10
   */
  maxPendingBatches?: number;

  // ── Module behavior ────────────────────────────────────────────────────

  /** Behavior when a disabled batch receives new items */
  disabledBehavior?: DisabledBehavior;

  /** Auto-remove completed batch jobs. @default false */
  removeOnComplete?: RemoveOnConfig;

  /** Auto-remove failed batch jobs. @default false */
  removeOnFail?: RemoveOnConfig;

  /** Keep N completed batch jobs. `true` = all, `false` = remove, number = keep N */
  keepHistory?: boolean | number;

  /** Keep N failed batch jobs */
  keepFailedHistory?: boolean | number;

  /**
   * Initial status. Use "paused" to register but not flush.
   * @default "active"
   */
  status?: "active" | "paused";

  /** Polling interval for batch job consumer loop. @default Uses heartbeatMs */
  pollIntervalMs?: number;
}

// ── Batch Job Context ───────────────────────────────────────────────────────

/**
 * Context passed to the batch handler on flush.
 * Contains the accumulated items and metadata about the batch.
 */
export interface BatchJobContext<T = any> {
  /** The batch job ID */
  readonly id: string;

  /** The batch definition name */
  readonly name: string;

  /** The accumulated items in this batch */
  readonly batch: T[];

  /** Number of items in this batch (shorthand for batch.length) */
  readonly batchSize: number;

  /** The group key if groupBy was used, undefined otherwise */
  readonly groupKey?: string;

  /** AbortSignal — fired when the job is cancelled or times out */
  readonly signal: AbortSignal;

  /** Shorthand for signal.aborted */
  readonly aborted: boolean;

  /** Current attempt number (1-based) */
  readonly attempt: number;

  /** Max configured attempts */
  readonly maxAttempts: number;

  /** When the batch job was created */
  readonly createdAt: Date;

  /** Live elapsed execution time in ms */
  readonly duration: number;

  /** Environment context (isolation boundary) */
  readonly environment: string;

  /** Project context (isolation boundary) */
  readonly project: string;

  /** Update execution progress (0–100) */
  progress(percent: number, label?: string): Promise<void>;

  /** Returns the current progress percent */
  getProgress(): number;

  /** Structured logging for batch execution */
  log: ((level: "info" | "warn" | "error", message: string) => void) & {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };

  /** Mark the batch job as permanently failed without retry */
  discard: () => void;
}

// ── Batch Payload ───────────────────────────────────────────────────────────

/** The job data payload created when a buffer is flushed */
export interface BatchPayload<T = any> {
  /** The accumulated items */
  items: T[];

  /** The group key (if groupBy was used) */
  groupKey?: string;

  /** When the first item was added to this buffer */
  bufferCreatedAt: number;

  /** When the buffer was flushed into a job */
  flushedAt: number;
}

// ── Buffer Record ───────────────────────────────────────────────────────────

/** Internal: the persisted buffer structure in storage */
export interface BatchBufferRecord<T = any> {
  /** Storage key (injected for list() identification) */
  id: string;

  /** Accumulated items awaiting flush */
  items: T[];

  /** Dedup keys seen in this buffer window (for deduplicateBy) */
  dedupeKeys: string[];

  /** Timestamp when first item was added */
  firstItemAt: number;

  /** Timestamp of most recent item */
  lastItemAt: number;

  /** Environment stamp for isolation verification */
  environment: string;

  /** Project stamp for isolation verification */
  project: string;
}

// ── Public API ──────────────────────────────────────────────────────────────

/** The user-facing batch instance returned by `batch()` */
export interface IBatch<T = any, R = any> {
  readonly name: string;

  /** Buffer a single item. Returns immediately. */
  add(item: T): Promise<void>;

  /** Buffer multiple items in one call. */
  addBulk(items: T[]): Promise<void>;

  /** Force-flush buffer immediately (optionally for a specific group). */
  flush(groupKey?: string): Promise<void>;

  /** Get the number of items currently buffered. */
  getBufferSize(groupKey?: string): Promise<number>;

  /** Retrieve a batch job by its ID. */
  getJob(id: string): Promise<OqronJob<BatchPayload<T>, R> | null>;

  /** List batch jobs, optionally filtered by status. */
  getJobs(filter?: {
    status?: string;
    limit?: number;
  }): Promise<OqronJob<BatchPayload<T>, R>[]>;

  /** Pause flushing — items can still be added. */
  pause(): Promise<void>;

  /** Resume flushing. */
  resume(): Promise<void>;

  /** Wait for active batch jobs to complete, then pause. */
  drain(): Promise<void>;
}
