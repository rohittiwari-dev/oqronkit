/** Comparison operators for filtered queries */
export type WhereOp = "$lt" | "$lte" | "$gt" | "$gte" | "$ne";

export interface WhereCondition {
  /** The field name to compare (top-level key in the record) */
  field: string;
  /** Comparison operator */
  op: WhereOp;
  /** The value to compare against */
  value: unknown;
}

export interface ListOptions {
  /** Maximum number of records to return. Defaults to all. */
  limit?: number;
  /** Number of records to skip (for pagination). Defaults to 0. */
  offset?: number;
  /** Optional deterministic ordering by a top-level record field. */
  orderBy?: {
    field: string;
    direction?: "asc" | "desc";
    type?: "number" | "date" | "string";
  };
  /**
   * Comparison conditions applied AFTER exact-match filter.
   * Fields with null/undefined values are excluded from comparison matches.
   */
  where?: WhereCondition[];
}

export interface StorageBulkRecord<T = any> {
  id: string;
  data: T;
}

/** Job ordering strategy for broker queues */
export type BrokerStrategy = "fifo" | "lifo" | "priority";

export interface IStorageEngine {
  /** Saves a generic entity into a namespace */
  save<T>(namespace: string, id: string, data: T): Promise<void>;

  /** Saves only when the entity does not already exist. Returns true on insert. */
  saveIfAbsent?<T>(namespace: string, id: string, data: T): Promise<boolean>;

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

  /** Saves many records. Implementations should prefer one atomic batch. */
  bulkSave?<T>(
    namespace: string,
    records: Array<StorageBulkRecord<T>>,
  ): Promise<void>;

  /** Deletes many records. Missing records are ignored. */
  bulkDelete?(namespace: string, ids: string[]): Promise<void>;

  /** Atomic bulk cleanup */
  prune(namespace: string, beforeMs: number): Promise<number>;

  /** Count total records in a namespace matching an optional filter */
  count(namespace: string, filter?: Record<string, any>): Promise<number>;

  /** Atomically increments a top-level numeric field and returns the new value. */
  increment?(
    namespace: string,
    id: string,
    field: string,
    by?: number,
  ): Promise<number>;

  /** Compare expected top-level fields and merge a patch when they match. */
  compareAndSet?<T extends Record<string, any>>(
    namespace: string,
    id: string,
    expected: Partial<T>,
    patch: Partial<T>,
  ): Promise<boolean>;
}

export interface BrokerPublishBatchItem {
  id: string;
  delayMs?: number;
  priority?: number;
}

export interface IBrokerEngine {
  /** Pushes an ID into a named broker. */
  publish(
    brokerName: string,
    id: string,
    delayMs?: number,
    priority?: number,
  ): Promise<void>;

  /** Pushes many IDs into one named broker. */
  publishBatch?(
    brokerName: string,
    ids: BrokerPublishBatchItem[],
  ): Promise<void>;

  /**
   * Claims a batch of IDs for a consumer worker.
   * @param strategy - Ordering strategy: 'fifo' (default), 'lifo', or 'priority'
   */
  claim(
    brokerName: string,
    consumerId: string,
    limit: number,
    lockTtlMs: number,
    strategy?: BrokerStrategy,
  ): Promise<string[]>;

  /** Renews the lock heartbeat. brokerName is optional for backward compatibility. */
  extendLock(
    id: string,
    consumerId: string,
    lockTtlMs: number,
    brokerName?: string,
  ): Promise<void>;

  /** Pops the entity out of the active broker locking list permanently */
  ack(brokerName: string, id: string): Promise<void>;

  /** Removes an ID from waiting, delayed, priority, and active broker state. */
  remove?(brokerName: string, id: string): Promise<void>;

  /**
   * Negative acknowledgement — re-queue a job back into the broker for retry.
   * Used for crash-safe retries: the job goes back to the waiting list with an
   * optional delay, so even if the process dies, the job is NOT lost.
   */
  nack(
    brokerName: string,
    id: string,
    delayMs?: number,
    priority?: number,
  ): Promise<void>;

  /** Pauses/Resumes all emissions from a specific broker namespace */
  pause(brokerName: string): Promise<void>;
  resume(brokerName: string): Promise<void>;
  isPaused?(brokerName: string): Promise<boolean>;
  size?(brokerName: string): Promise<number>;

  /**
   * Blocking claim — waits up to `timeoutMs` for a job to become available.
   * Uses BLPOP (Redis) or promise-based wait (Memory) to eliminate active polling.
   * Returns null if no job appears within the timeout.
   *
   * Optional — engines fall back to `claim()` if not implemented.
   */
  claimBlocking?(
    brokerName: string,
    consumerId: string,
    lockTtlMs: number,
    timeoutMs: number,
    strategy?: BrokerStrategy,
  ): Promise<string | null>;

  /**
   * Broadcast a non-durable fanout message to every subscriber on a channel.
   * This is distinct from publish/claim queue semantics.
   */
  broadcast?(channel: string, message: unknown): Promise<void>;

  /**
   * Subscribe to non-durable fanout messages on a channel.
   * Returns an unsubscribe cleanup function.
   */
  subscribe?(
    channel: string,
    handler: (message: unknown) => void | Promise<void>,
  ): Promise<() => void | Promise<void>>;
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

/**
 * Implemented by adapters that hold connection pools (PG pools, etc.)
 * and need explicit cleanup during engine shutdown.
 */
export interface ICloseable {
  close(): Promise<void>;
}
