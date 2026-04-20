import type { DisabledBehavior } from "../engine/types/config.types.js";
import type { BrokerStrategy } from "../engine/types/engine.js";
import type { OqronJob, RemoveOnConfig } from "../engine/types/job.types.js";
import type { QueueJobContext } from "../queue/types.js";

export interface WorkerConfig<T = any, R = any> {
  /**
   * The Broker topic (queue name) this worker should consume from.
   */
  topic: string;

  /**
   * The processing function. Unlike QueueConfig, a Worker MUST have a handler.
   */
  handler: (ctx: QueueJobContext<T>) => Promise<R>;

  /**
   * Number of jobs this worker can safely process in parallel.
   * Defaults to 5.
   */
  concurrency?: number;

  /**
   * If true, uses crash-safe heartbeat locks to ensure at-least-once execution.
   * Defaults to true.
   */
  guaranteedWorker?: boolean;

  /**
   * Polling interval in ms for crash-safe heartbeat lock renewals.
   */
  heartbeatMs?: number;

  /**
   * The TTL of the underlying lock in ms.
   * If the process crashes, the lock will expire after this time.
   */
  lockTtlMs?: number;

  /**
   * Strategy for picking the next job.
   * - "fifo": First in, first out (default)
   * - "lifo": Last in, first out
   */
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
   * Default priority for all jobs consumed by this worker.
   * Lower number = higher priority.
   */
  priority?: number;

  /**
   * F6: Pre-execution condition gate.
   * If the condition returns false, the job is nacked with a delay (re-queued).
   * Runs after `beforeRun` hook. Useful for circuit-breaker patterns.
   */
  condition?: (ctx: import("../queue/types.js").QueueJobContext) => Promise<boolean> | boolean;

  /**
   * Optional override for retry settings for this worker specifically.
   */
  retries?: {
    max?: number;
    strategy?: "fixed" | "exponential" | "custom";
    baseDelay?: number;
    maxDelay?: number;
    /** F7: Custom backoff function. Only used when strategy is "custom". */
    backoffFn?: (attempt: number, baseDelay: number) => number;
  };

  /**
   * Dead letter queue hooks for permanently failed jobs.
   */
  deadLetter?: {
    enabled?: boolean;
    onDead?: (job: OqronJob<T, R>) => Promise<void>;
  };

  /**
   * Hooks run upon completion or failure.
   */
  hooks?: {
    /** Called before handler execution. Throw to skip. */
    beforeRun?: (ctx: QueueJobContext) => Promise<void> | void;
    /** Called when the handler fulfills */
    onSuccess?: (job: OqronJob<T, R>, result: R) => Promise<void> | void;
    /** Called when the handler rejects */
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

  /** Define whether a job gets removed when completed. */
  removeOnComplete?: RemoveOnConfig;
  /** Define whether a job gets removed when it fails. */
  removeOnFail?: RemoveOnConfig;

  /**
   * Define how this worker behaves if OqronKit or this module is disabled globally.
   * Only useful if you want this specific worker to ignore the `disabled` setting.
   */
  disabledBehavior?: DisabledBehavior;
}

/**
 * A worker instance. A worker only consumes jobs.
 * It has no `.add()` method and cannot push jobs to the broker.
 */
export interface IWorker {
  /** The specific Broker topic this worker is consuming. */
  readonly topic: string;
}
