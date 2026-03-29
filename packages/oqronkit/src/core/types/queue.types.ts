/**
 * QueueMetrics — High-level counters for queue health.
 */
export interface QueueMetrics {
  active: number;
  waiting: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
}

/**
 * IBrokerAdapter — The "Signaling" engine.
 * Responsible for high-speed job orchestration and cross-node coordination.
 * Focuses on ID-based transport rather than full record storage.
 */
export interface IQueueAdapter {
  /**
   * Signal that a job is ready for processing.
   * @param queueName Target queue
   * @param jobId The unique ID of the job already persisted in DB
   * @param delayMs Optional delay before the job becomes claimable
   */
  signalEnqueue(
    queueName: string,
    jobId: string,
    delayMs?: number,
  ): Promise<void>;

  /**
   * Atomically claim N job IDs for a specific worker.
   * Transitions IDs from 'waiting' to 'active' state in the broker.
   */
  claimJobIds(
    queueName: string,
    workerId: string,
    limit: number,
    lockTtlMs: number,
    limiter?: { max: number; duration: number; groupKey?: string },
  ): Promise<string[]>;

  /**
   * Extend the TTL for an active job ID.
   */
  extendLock(jobId: string, workerId: string, lockTtlMs: number): Promise<void>;

  /**
   * Acknowledge completion and remove from broker tracking.
   */
  ack(jobId: string): Promise<void>;

  /**
   * Implementation-specific pause/resume signaling.
   */
  setQueuePaused(queueName: string, paused: boolean): Promise<void>;

  /** Check connectivity to the broker engine. */
  ping(): Promise<boolean>;
}
