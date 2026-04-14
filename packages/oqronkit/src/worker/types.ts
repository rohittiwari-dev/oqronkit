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

  /**
   * Optional override for retry settings for this worker specifically.
   */
  retries?: {
    max?: number;
    strategy?: "fixed" | "exponential";
    baseDelay?: number;
    maxDelay?: number;
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
    /** Called when the handler fulfills */
    onSuccess?: (job: OqronJob<T, R>, result: R) => Promise<void> | void;
    /** Called when the handler rejects */
    onFail?: (job: OqronJob<T, R>, error: Error) => Promise<void> | void;
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
