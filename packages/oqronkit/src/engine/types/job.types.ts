export type JobType =
  | "task"
  | "cron"
  | "webhook"
  | "batch"
  | "workflow"
  | "saga";

export type JobStatus =
  | "pending" // Created in DB, not yet signaled to broker
  | "waiting" // Signaled to broker, ready for worker
  | "active" // Claimed by a worker
  | "completed" // Finished successfully
  | "failed" // Finished with error (retries exhausted)
  | "delayed" // Waiting for a specific timestamp
  | "paused"; // Manually stopped

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
 * Unified OqronJob Model
 * The single source of truth for every background operation in the system.
 */
export interface OqronJob<T = any, R = any> {
  id: string;
  type: JobType;
  queueName: string;
  status: JobStatus;

  // Payloads
  data: T;
  opts: OqronJobOptions;

  // Execution State
  attemptMade: number;
  progressPercent: number;
  progressLabel?: string;
  workerId?: string;

  // Results
  returnValue?: R;
  error?: string;
  stacktrace?: string[];

  // Relationships
  parentId?: string;
  scheduleId?: string; // Linked to a Cron/Schedule definition

  // Metadata
  tags: string[];
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  runAt?: Date; // Specifically for delayed/scheduled jobs
}

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
