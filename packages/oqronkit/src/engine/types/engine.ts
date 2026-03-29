export interface ListOptions {
  /** Maximum number of records to return. Defaults to all. */
  limit?: number;
  /** Number of records to skip (for pagination). Defaults to 0. */
  offset?: number;
}

export interface IStorageEngine {
  /** Saves a generic entity into a namespace */
  save<T>(namespace: string, id: string, data: T): Promise<void>;

  /** Retrieves an entity */
  get<T>(namespace: string, id: string): Promise<T | null>;

  /** Queries entities in a namespace with optional filtering and pagination */
  list<T>(
    namespace: string,
    filter?: Record<string, any>,
    opts?: ListOptions,
  ): Promise<T[]>;

  /** Removes an entity */
  delete(namespace: string, id: string): Promise<void>;

  /** Atomic bulk cleanup */
  prune(namespace: string, beforeMs: number): Promise<number>;

  /** Count total records in a namespace matching an optional filter */
  count(namespace: string, filter?: Record<string, any>): Promise<number>;
}

export interface IBrokerEngine {
  /** Pushes an ID into a named broker. */
  publish(brokerName: string, id: string, delayMs?: number): Promise<void>;

  /** Claims a batch of IDs for a consumer worker. */
  claim(
    brokerName: string,
    consumerId: string,
    limit: number,
    lockTtlMs: number,
  ): Promise<string[]>;

  /** Renews the lock heartbeat */
  extendLock(id: string, consumerId: string, lockTtlMs: number): Promise<void>;

  /** Pops the entity out of the active broker locking list permanently */
  ack(brokerName: string, id: string): Promise<void>;

  /**
   * Negative acknowledgement — re-queue a job back into the broker for retry.
   * Used for crash-safe retries: the job goes back to the waiting list with an
   * optional delay, so even if the process dies, the job is NOT lost.
   */
  nack(brokerName: string, id: string, delayMs?: number): Promise<void>;

  /** Pauses/Resumes all emissions from a specific broker namespace */
  pause(brokerName: string): Promise<void>;
  resume(brokerName: string): Promise<void>;
}

/**
 * ILockAdapter — Thin distributed-lock contract.
 * Used by LeaderElection, HeartbeatWorker, StallDetector.
 * Can be backed by Redis (SETNX+PX) or by in-memory Maps.
 */
export interface ILockAdapter {
  acquire(key: string, ownerId: string, ttlMs: number): Promise<boolean>;
  renew(key: string, ownerId: string, ttlMs: number): Promise<boolean>;
  release(key: string, ownerId: string): Promise<void>;
  isOwner(key: string, ownerId: string): Promise<boolean>;
}
