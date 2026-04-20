import type { DisabledBehavior } from "../engine/types/config.types.js";
import type { BrokerStrategy } from "../engine/types/engine.js";
import type { OqronJob, OqronJobOptions } from "../engine/types/job.types.js";

export interface QueueJobContext<T = any> {
  /** The internal idempotency key or generated UUID of the job */
  id: string;

  /** The queue/topic definition name (unified — replaces queueName + moduleName) */
  name: string;

  /** The typed payload provided during tracking */
  data: T;

  /**
   * AbortSignal — fired when the job is cancelled mid-execution.
   * Handlers should check `ctx.signal.aborted` periodically for long-running work.
   */
  signal: AbortSignal;

  /** Shorthand for signal.aborted */
  readonly aborted: boolean;

  /** Update the progression of the job, propagated to events */
  progress: (percent: number, label?: string) => Promise<void>;

  /**
   * Log execution telemetry.
   * Can be called as `ctx.log("info", msg)` or via object API:
   * `ctx.log.info(msg)`, `ctx.log.warn(msg)`, `ctx.log.error(msg)` (C2).
   */
  log: ((level: "info" | "warn" | "error", message: string) => void) & {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };

  /** Mark the job as permanently failed without triggering backoff retries */
  discard: () => void;

  /** Current attempt number (1-based) */
  attempt: number;

  /** Max attempts configured */
  maxAttempts: number;

  /** When the job was created/queued */
  createdAt: Date;

  /**
   * C1: Live elapsed execution time in milliseconds.
   * Returns `Date.now() - startedAt` — useful for progress-aware handlers.
   */
  readonly duration: number;

  /**
   * C3: Returns the current progress percent (0–100) for this job.
   */
  getProgress: () => number;

  /** The environment context (isolation boundary) */
  environment: string;

  /** The project context (isolation boundary) */
  project: string;
}

export interface QueueConfig<T = any, R = any> {
  /** The unified identifier for this specific task pipeline */
  name: string;

  /** Provide lock-guarantees for crash recovery. Defaults to true. */
  guaranteedWorker?: boolean;

  /** Internal heartbeat polling. Overrides global config. */
  heartbeatMs?: number;

  /** Lock TTL in the adapter. Overrides global config. */
  lockTtlMs?: number;

  /** Parallel execution limit. Overrides global config. */
  concurrency?: number;

  /** Job ordering strategy. Overrides global config. @default "fifo" */
  strategy?: BrokerStrategy;

  /** Tags for categorization and dashboard filtering */
  tags?: string[];

  /** Initial status. Use "paused" to register but not process. @default "active" */
  status?: "active" | "paused";

  /** Schema version — bump to trigger config migration */
  version?: number;

  /** Pre-execution rate limiter. If check() returns { allowed: false }, job is nacked. */
  rateLimiter?: { check(ctx: any): Promise<{ allowed: boolean }> };

  /**
   * Polling interval in ms, separate from heartbeat.
   * When set, polling uses this interval; heartbeat uses `heartbeatMs`.
   * @default Uses `heartbeatMs` for backward compatibility.
   */
  pollIntervalMs?: number;

  /**
   * F10: Random jitter added to poll intervals to prevent thundering herd
   * when multiple workers start simultaneously.
   * Final interval = pollIntervalMs + Math.random() * jitterMs.
   * @default 0
   */
  jitterMs?: number;

  /**
   * Default priority for all jobs added to this queue.
   * Individual jobs can override this via `OqronJobOptions.priority`.
   * Lower number = higher priority.
   */
  priority?: number;

  /**
   * F6: Pre-execution condition gate.
   * If the condition returns false, the job is nacked with a delay (re-queued).
   * Runs after `beforeRun` hook. Useful for circuit-breaker patterns.
   */
  condition?: (ctx: QueueJobContext) => Promise<boolean> | boolean;

  /** Native worker retry logic. Deep-merged with global config. */
  retries?: {
    max?: number;
    strategy?: "fixed" | "exponential" | "custom";
    baseDelay?: number;
    maxDelay?: number;
    /** F7: Custom backoff function. Only used when strategy is "custom". */
    backoffFn?: (attempt: number, baseDelay: number) => number;
  };

  /** DLQ hooks */
  deadLetter?: {
    enabled?: boolean;
    onDead?: (job: OqronJob<T, R>) => Promise<void>;
  };

  /**
   * Behavior when a job is added to this queue but the queue is disabled.
   * - "hold": Accept the job, place it in "paused" status (default)
   * - "skip": Silently drop the job without enqueueing
   * - "reject": Throw an error explicitly rejecting the enqueue attempt
   */
  disabledBehavior?: DisabledBehavior;

  /**
   * Auto-remove completed jobs after processing.
   * Overrides global config. See OqronJobOptions.removeOnComplete.
   */
  removeOnComplete?: import("../engine/types/job.types.js").RemoveOnConfig;

  /**
   * Auto-remove failed jobs after all retries exhausted.
   * Overrides global config. See OqronJobOptions.removeOnFail.
   */
  removeOnFail?: import("../engine/types/job.types.js").RemoveOnConfig;

  /** Natively execute direct local callbacks when the monolithic processor succeeds or fails */
  hooks?: {
    /** Called before handler execution. Throw to skip. */
    beforeRun?: (ctx: QueueJobContext) => Promise<void> | void;
    /** Called when the handler fulfills successfully */
    onSuccess?: (job: OqronJob<T, R>, result: R) => Promise<void> | void;
    /** Called when the handler rejects with an error */
    onFail?: (job: OqronJob<T, R>, error: Error) => Promise<void> | void;
    /**
     * DX3: Alias for onSuccess — called after handler completes successfully.
     * If both `afterRun` and `onSuccess` are set, both are invoked.
     */
    afterRun?: (job: OqronJob<T, R>, result: R) => Promise<void> | void;
    /**
     * DX3: Alias for onFail — called after handler rejects.
     * If both `onError` and `onFail` are set, both are invoked.
     */
    onError?: (job: OqronJob<T, R>, error: Error) => Promise<void> | void;
  };

  /**
   * Execution timeout in milliseconds.
   * If the handler does not fulfill within this time, it is aborted and fails.
   */
  timeout?: number;

  /**
   * The monolithic processing function.
   * When omitted, this queue acts as a **Publisher-Only** endpoint: it can
   * push jobs to the broker but will NOT start any polling or execution loops.
   * Use the `worker()` factory on a separate node to consume these jobs.
   */
  handler?: (job: QueueJobContext<T>) => Promise<R>;
}

export interface IQueue<T = any, R = any> {
  readonly name: string;
  /**
   * Pushes a new payload onto the queue.
   */
  add(data: T, opts?: OqronJobOptions): Promise<OqronJob<T, R>>;

  /**
   * Push multiple payloads onto the queue in a single call.
   */
  addBulk(items: Array<{ data: T; opts?: OqronJobOptions }>): Promise<OqronJob<T, R>[]>;

  /**
   * Retrieve a specific job by its ID.
   */
  getJob(id: string): Promise<OqronJob<T, R> | null>;

  /**
   * List jobs for this queue, optionally filtering by status.
   */
  getJobs(filter?: { status?: string; limit?: number }): Promise<OqronJob<T, R>[]>;

  /**
   * Count jobs for this queue, optionally filtered by status.
   */
  count(status?: string): Promise<number>;

  /**
   * Pause this queue — stops claiming new jobs.
   */
  pause(): Promise<void>;

  /**
   * Resume this queue — re-enables job claiming.
   */
  resume(): Promise<void>;

  /**
   * Check whether this queue is currently paused.
   */
  isPaused(): Promise<boolean>;

  /**
   * Wait for active jobs to complete, then pause the queue.
   */
  drain(): Promise<void>;

  /**
   * Remove all jobs for this queue from storage and broker.
   */
  obliterate(): Promise<number>;
}

/**
 * A queue instance that can only push jobs (no handler, no polling).
 * Returned when `queue()` is called without a handler.
 */
export interface IPublisherQueue<T = any> {
  readonly name: string;
  /**
   * Pushes a new payload onto the queue.
   */
  add(data: T, opts?: OqronJobOptions): Promise<OqronJob<T>>;
}
