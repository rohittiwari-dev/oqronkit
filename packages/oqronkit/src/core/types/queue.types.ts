export interface OqronJobData<T = any, R = any> {
  id: string; // unique auto-generated ID or user-provided idempotency key
  queueName: string; // The topic/queue name (e.g. 'payment-processor')
  data: T; // User payload
  opts?: OqronJobOptions;
  parentId?: string;

  // Execution State
  attemptMade: number;
  waitingChildrenCount?: number;
  status:
    | "waiting-children"
    | "waiting"
    | "active"
    | "completed"
    | "failed"
    | "delayed"
    | "paused";

  // Timestamps
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;

  // Results
  returnValue?: R;
  failedReason?: string;
  stacktrace?: string[];

  // Telemetry
  progressPercent: number;
  progressLabel?: string;
  workerId?: string;
}

export interface OqronJobOptions {
  jobId?: string; // Custom ID for deduplication
  priority?: number; // 1 (highest) to MAX_INT
  delay?: number; // Milliseconds to wait until this job can be processed
  attempts?: number; // Maximum attempts
  backoff?: {
    type: "fixed" | "exponential";
    delay: number; // Base delay in ms
  };
  removeOnComplete?: boolean | number; // true, or number of records to keep
  removeOnFail?: boolean | number;
}

export interface FlowJobNode<T = any> {
  name: string;
  queueName: string;
  data: T;
  opts?: OqronJobOptions;
  children?: FlowJobNode<any>[];
}

/**
 * Universal interface for persistent queue storage operations.
 * Allows Memory, Redis, or Postgres to handle job orchestration.
 */
export interface IQueueAdapter {
  /**
   * Push a new job onto the queue.
   * Must handle deduplication if `opts.jobId` already exists natively.
   */
  enqueue<T>(
    queueName: string,
    data: T,
    opts?: OqronJobOptions,
  ): Promise<OqronJobData<T>>;

  /** Push multiple jobs atomically */
  enqueueBulk<T>(
    queueName: string,
    jobs: { data: T; opts?: OqronJobOptions }[],
  ): Promise<OqronJobData<T>[]>;

  /** Push a complex parent-child DAG map */
  enqueueFlow(flow: FlowJobNode): Promise<OqronJobData>;

  /**
   * Used by Workers to fetch work.
   * Atomically claims `limit` number of jobs, transitioning them from 'waiting' to 'active'
   * and assigning the `workerId` with a specific lock TTL.
   */
  claimJobs(
    queueName: string,
    limit: number,
    workerId: string,
    lockTtlMs: number,
  ): Promise<OqronJobData[]>;

  /**
   * Extends the TTL lock for jobs currently being processed by this worker.
   * Throws if the job was stolen/expired.
   */
  extendLock(jobId: string, workerId: string, lockTtlMs: number): Promise<void>;

  /**
   * Mark a job as fully processed.
   * Clears the active lock cleanly.
   */
  completeJob(jobId: string, returnValue?: any): Promise<void>;

  /**
   * Mark a job as failed.
   * The adapter is responsible for decrementing attempts and pushing it
   * to a 'delayed' state if backoff applies, or 'failed' (DLQ) if out of retries.
   */
  failJob(jobId: string, reason: string, stacktrace?: string): Promise<void>;

  /** Update user-defined progress metrics. */
  updateProgress(jobId: string, percent: number, label?: string): Promise<void>;

  /** Get raw job data. */
  getJob(jobId: string): Promise<OqronJobData | null>;

  /** Delete a job payload completely. */
  removeJob(jobId: string): Promise<void>;
}
