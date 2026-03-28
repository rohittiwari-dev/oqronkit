import type {
  OqronJobData,
  OqronJobOptions,
} from "../core/types/queue.types.js";

export interface TaskJobContext<T = any> {
  /** The internal idempotency key or generated UUID of the job */
  id: string;

  /** The typed payload provided during tracking */
  data: T;

  /** Update the progression of the job, propagated to events */
  progress: (percent: number, label?: string) => Promise<void>;

  /** Log execution telemetry */
  log: (level: "info" | "warn" | "error", message: string) => void;

  /** Mark the job as permanently failed without triggering backoff retries */
  discard: () => void;
}

export interface TaskQueueConfig<T = any, R = any> {
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

  /** Native worker retry logic. Deep-merged with global config. */
  retries?: {
    max?: number;
    strategy?: "fixed" | "exponential";
    baseDelay?: number;
    maxDelay?: number;
  };

  /** DLQ hooks */
  deadLetter?: {
    enabled?: boolean;
    onDead?: (job: OqronJobData<T, R>) => Promise<void>;
  };

  /** Natively execute direct local callbacks when the monolithic processor succeeds or fails */
  hooks?: {
    onSuccess?: (job: OqronJobData<T, R>, result: R) => Promise<void> | void;
    onFail?: (job: OqronJobData<T, R>, error: Error) => Promise<void> | void;
  };

  /**
   * The monolithic processing function.
   * Required for taskQueue.
   */
  handler: (job: TaskJobContext<T>) => Promise<R>;
}

export interface ITaskQueue<T = any, R = any> {
  /**
   * Pushes a new payload onto the task queue.
   */
  add(data: T, opts?: OqronJobOptions): Promise<OqronJobData<T, R>>;
}
