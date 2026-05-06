/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  OqronKit — Adapter Factories
 *
 *  User-facing functions to create storage, broker, and lock adapters.
 *  These allow developers to:
 *
 *  1. Create all 3 adapters at once with `createAdapters()`
 *  2. Create individual adapters for mix-and-match setups
 *  3. Use built-in adapters (Memory, Redis, PostgreSQL) or bring their own
 *
 *  The adapters returned are raw — no isolation prefix is applied.
 *  When passed to `OqronKit.init({ config: { mode: 'custom', adapters } })`,
 *  OqronKit wraps them with environment/project isolation automatically.
 *
 *  @example Mix-and-match: Postgres storage + RabbitMQ broker + Redis lock
 *  ```ts
 *  import { createStorageAdapter, OqronKit } from 'oqronkit'
 *  import { MyRabbitBroker } from './adapters/rabbit-broker'
 *
 *  const storage = await createStorageAdapter({ type: 'postgres', postgres: { connectionString: '...' } })
 *  const lock = await createLockAdapter({ type: 'redis', redis: 'redis://localhost:6379' })
 *
 *  await OqronKit.init({
 *    config: {
 *      mode: 'custom',
 *      adapters: {
 *        storage,
 *        broker: new MyRabbitBroker(),   // your own adapter
 *        lock,
 *      },
 *    },
 *  })
 *  ```
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import type { RedisLike } from "./types/config.types.js";
import type {
  IBrokerEngine,
  ILockAdapter,
  IStorageEngine,
} from "./types/engine.js";

// ── Shared Types ────────────────────────────────────────────────────────────

/** Configuration for PostgreSQL-based adapters */
export interface PostgresAdapterConfig {
  /** Connection string (e.g. 'postgresql://user:pass@host:5432/db') */
  connectionString: string;
  /** Table name prefix. @default "oqron" */
  tablePrefix?: string;
  /** Connection pool size. @default 10 */
  poolSize?: number;
}

/** Configuration for Redis-based adapters */
export interface RedisAdapterConfig {
  /**
   * Redis connection. Accepts:
   * - A URL string: `"redis://localhost:6379"`
   * - A config object: `{ url: "redis://...", password: "..." }`
   * - A pre-initialized ioredis client instance
   */
  redis: RedisLike;
  /** Key prefix for all Redis keys. @default "oqron" */
  prefix?: string;
}

// ── Result Types ────────────────────────────────────────────────────────────

/** The complete set of adapters returned by `createAdapters()` */
export interface OqronAdapters {
  storage: IStorageEngine;
  broker: IBrokerEngine;
  lock: ILockAdapter;
  /**
   * Closes all owned connections (Redis/PG pools).
   * Call this when shutting down if you created adapters manually.
   */
  close: () => Promise<void>;
}

// ── Storage Adapter Factory ─────────────────────────────────────────────────

/** Options for `createStorageAdapter()` */
export type StorageAdapterOptions =
  | { type: "memory" }
  | { type: "postgres"; postgres: PostgresAdapterConfig }
  | { type: "redis"; redis: RedisLike; prefix?: string };

/**
 * Creates a storage adapter (IStorageEngine) from a type + config.
 *
 * @example Memory (development)
 * ```ts
 * const storage = await createStorageAdapter({ type: 'memory' })
 * ```
 *
 * @example PostgreSQL (durable)
 * ```ts
 * const storage = await createStorageAdapter({
 *   type: 'postgres',
 *   postgres: { connectionString: 'postgresql://user:pass@localhost:5432/mydb' },
 * })
 * ```
 *
 * @example Redis
 * ```ts
 * const storage = await createStorageAdapter({
 *   type: 'redis',
 *   redis: 'redis://localhost:6379',
 * })
 * ```
 */
export async function createStorageAdapter(
  opts: StorageAdapterOptions,
): Promise<IStorageEngine> {
  if (opts.type === "memory") {
    const { MemoryStore } = await import("./memory/memory-store.js");
    return new MemoryStore();
  }

  if (opts.type === "postgres") {
    const { PostgresStore } = await import("./postgres/postgres-store.js");
    const prefix = opts.postgres.tablePrefix ?? "oqron";
    const pool = opts.postgres.poolSize ?? 10;
    return new PostgresStore(opts.postgres.connectionString, prefix, pool);
  }

  if (opts.type === "redis") {
    const { RedisStore } = await import("./redis/redis-store.js");
    const client = await resolveRedis(opts.redis);
    return new RedisStore(client, opts.prefix ?? "oqron");
  }

  throw new Error(
    `[OqronKit] Unknown storage adapter type: ${(opts as any).type}`,
  );
}

// ── Broker Adapter Factory ──────────────────────────────────────────────────

/** Options for `createBrokerAdapter()` */
export type BrokerAdapterOptions =
  | { type: "memory" }
  | { type: "postgres"; postgres: PostgresAdapterConfig }
  | { type: "redis"; redis: RedisLike; prefix?: string };

/**
 * Creates a broker adapter (IBrokerEngine) from a type + config.
 *
 * The broker handles job queuing: publish, claim, ack, nack.
 * For custom brokers (RabbitMQ, Kafka, SQS), implement IBrokerEngine
 * directly and pass to `config.adapters.broker`.
 *
 * @example Memory (development)
 * ```ts
 * const broker = await createBrokerAdapter({ type: 'memory' })
 * ```
 *
 * @example Redis (distributed)
 * ```ts
 * const broker = await createBrokerAdapter({
 *   type: 'redis',
 *   redis: 'redis://localhost:6379',
 * })
 * ```
 */
export async function createBrokerAdapter(
  opts: BrokerAdapterOptions,
): Promise<IBrokerEngine> {
  if (opts.type === "memory") {
    const { MemoryBroker } = await import("./memory/memory-broker.js");
    return new MemoryBroker();
  }

  if (opts.type === "postgres") {
    const { PostgresBroker } = await import("./postgres/postgres-broker.js");
    const prefix = opts.postgres.tablePrefix ?? "oqron";
    const pool = opts.postgres.poolSize ?? 10;
    return new PostgresBroker(opts.postgres.connectionString, prefix, pool);
  }

  if (opts.type === "redis") {
    const { RedisBroker } = await import("./redis/redis-broker.js");
    const client = await resolveRedis(opts.redis);
    return new RedisBroker(client, opts.prefix ?? "oqron");
  }

  throw new Error(
    `[OqronKit] Unknown broker adapter type: ${(opts as any).type}`,
  );
}

// ── Custom Adapter Factories ────────────────────────────────────────────────
//
// Let users build their own adapters by providing method implementations.
// No class boilerplate needed — just implement the methods you need.
//
//   const storage = createStorage({ save: ..., get: ..., list: ..., ... })
//   const broker  = createBroker({ publish: ..., claim: ..., ack: ..., ... })
//   const lock    = createLock({ acquire: ..., renew: ..., release: ..., ... })
//

/**
 * Create a custom storage adapter that implements `IStorageEngine`.
 *
 * Provide your own implementations for each storage method. This is useful
 * when integrating OqronKit with databases not natively supported (e.g.
 * DynamoDB, MongoDB, SQLite, Turso, etc.).
 *
 * @example
 * ```ts
 * import { createStorage } from 'oqronkit'
 *
 * const dynamoStorage = createStorage({
 *   async save(namespace, id, data) {
 *     await dynamo.putItem({ TableName: namespace, Item: { id, ...data } })
 *   },
 *   async get(namespace, id) {
 *     const result = await dynamo.getItem({ TableName: namespace, Key: { id } })
 *     return result.Item ?? null
 *   },
 *   async list(namespace, filter, opts) {
 *     // your scan/query logic
 *     return []
 *   },
 *   async delete(namespace, id) {
 *     await dynamo.deleteItem({ TableName: namespace, Key: { id } })
 *   },
 *   async prune(namespace, beforeMs) {
 *     // your cleanup logic
 *     return 0
 *   },
 *   async count(namespace, filter) {
 *     // your count logic
 *     return 0
 *   },
 * })
 * ```
 */
export function createStorage(impl: IStorageEngine): IStorageEngine {
  if (!impl.save || !impl.get || !impl.list || !impl.delete || !impl.prune || !impl.count) {
    throw new Error(
      "[OqronKit] createStorage: all IStorageEngine methods are required " +
      "(save, get, list, delete, prune, count)",
    );
  }
  return impl;
}

/**
 * Create a custom broker adapter that implements `IBrokerEngine`.
 *
 * Provide your own implementations for each broker method. This is useful
 * when integrating OqronKit with message brokers not natively supported
 * (e.g. RabbitMQ, Kafka, AWS SQS, Google Cloud Pub/Sub, NATS, etc.).
 *
 * `claimBlocking` is optional — if omitted, engines fall back to polling `claim()`.
 *
 * @example
 * ```ts
 * import { createBroker } from 'oqronkit'
 *
 * const rabbitBroker = createBroker({
 *   async publish(brokerName, id, delayMs, priority) {
 *     await rabbit.sendToQueue(brokerName, Buffer.from(id), { priority })
 *   },
 *   async claim(brokerName, consumerId, limit, lockTtlMs, strategy) {
 *     const msg = await rabbit.get(brokerName)
 *     return msg ? [msg.content.toString()] : []
 *   },
 *   async extendLock(id, consumerId, lockTtlMs) { },
 *   async ack(brokerName, id) {
 *     // acknowledge message
 *   },
 *   async nack(brokerName, id, delayMs) {
 *     // re-queue with optional delay
 *   },
 *   async pause(brokerName) { },
 *   async resume(brokerName) { },
 * })
 * ```
 */
export function createBroker(impl: IBrokerEngine): IBrokerEngine {
  if (
    !impl.publish || !impl.claim || !impl.extendLock ||
    !impl.ack || !impl.nack || !impl.pause || !impl.resume
  ) {
    throw new Error(
      "[OqronKit] createBroker: all required IBrokerEngine methods are needed " +
      "(publish, claim, extendLock, ack, nack, pause, resume)",
    );
  }
  return impl;
}

/**
 * Create a custom lock adapter that implements `ILockAdapter`.
 *
 * Provide your own implementations for each lock method. This is useful
 * when integrating OqronKit with distributed lock backends not natively
 * supported (e.g. etcd, Consul, ZooKeeper, DynamoDB conditional writes).
 *
 * @example
 * ```ts
 * import { createLock } from 'oqronkit'
 *
 * const consulLock = createLock({
 *   async acquire(key, ownerId, ttlMs) {
 *     const session = await consul.session.create({ ttl: `${ttlMs}ms` })
 *     return consul.kv.acquire({ key, session, value: ownerId })
 *   },
 *   async renew(key, ownerId, ttlMs) {
 *     return consul.session.renew(ownerId)
 *   },
 *   async release(key, ownerId) {
 *     await consul.kv.release({ key, session: ownerId })
 *   },
 *   async isOwner(key, ownerId) {
 *     const result = await consul.kv.get(key)
 *     return result?.Value === ownerId
 *   },
 * })
 * ```
 */
export function createLock(impl: ILockAdapter): ILockAdapter {
  if (!impl.acquire || !impl.renew || !impl.release || !impl.isOwner) {
    throw new Error(
      "[OqronKit] createLock: all ILockAdapter methods are required " +
      "(acquire, renew, release, isOwner)",
    );
  }
  return impl;
}

// ── Lock Adapter Factory ────────────────────────────────────────────────────

/** Options for `createLockAdapter()` */
export type LockAdapterOptions =
  | { type: "memory" }
  | { type: "postgres"; postgres: PostgresAdapterConfig }
  | { type: "redis"; redis: RedisLike; prefix?: string };

/**
 * Creates a lock adapter (ILockAdapter) from a type + config.
 *
 * The lock handles distributed mutual exclusion: leader election,
 * heartbeat locks, and crash recovery via TTL expiration.
 *
 * @example Memory (development)
 * ```ts
 * const lock = await createLockAdapter({ type: 'memory' })
 * ```
 *
 * @example Redis (distributed)
 * ```ts
 * const lock = await createLockAdapter({
 *   type: 'redis',
 *   redis: 'redis://localhost:6379',
 * })
 * ```
 */
export async function createLockAdapter(
  opts: LockAdapterOptions,
): Promise<ILockAdapter> {
  if (opts.type === "memory") {
    const { MemoryLock } = await import("./memory/memory-lock.js");
    return new MemoryLock();
  }

  if (opts.type === "postgres") {
    const { PostgresLock } = await import("./postgres/postgres-lock.js");
    const prefix = opts.postgres.tablePrefix ?? "oqron";
    const pool = opts.postgres.poolSize ?? 10;
    return new PostgresLock(opts.postgres.connectionString, prefix, pool);
  }

  if (opts.type === "redis") {
    const { RedisLock } = await import("./redis/redis-lock.js");
    const client = await resolveRedis(opts.redis);
    return new RedisLock(client, opts.prefix ?? "oqron");
  }

  throw new Error(
    `[OqronKit] Unknown lock adapter type: ${(opts as any).type}`,
  );
}

// ── Unified Adapter Factory ─────────────────────────────────────────────────

/** Options for `createAdapters()` — creates all three adapters at once */
export type CreateAdaptersOptions =
  | { mode: "default" }
  | { mode: "db"; postgres: PostgresAdapterConfig }
  | { mode: "redis"; redis: RedisLike; prefix?: string }
  | {
      mode: "hybrid-db";
      postgres: PostgresAdapterConfig;
      redis: RedisLike;
      redisPrefix?: string;
    }
  | {
      mode: "custom";
      storage: IStorageEngine;
      broker: IBrokerEngine;
      lock: ILockAdapter;
    };

/**
 * Creates all three adapters (storage, broker, lock) based on a mode.
 *
 * This is the recommended way to create adapters for `mode: "custom"`.
 * Returns raw adapters + a `close()` function for cleanup.
 *
 * @example Default (in-memory)
 * ```ts
 * const adapters = await createAdapters({ mode: 'default' })
 * ```
 *
 * @example Redis (distributed)
 * ```ts
 * const adapters = await createAdapters({
 *   mode: 'redis',
 *   redis: 'redis://localhost:6379',
 * })
 * ```
 *
 * @example Hybrid (PG storage + Redis broker/lock)
 * ```ts
 * const adapters = await createAdapters({
 *   mode: 'hybrid-db',
 *   postgres: { connectionString: 'postgresql://...' },
 *   redis: 'redis://localhost:6379',
 * })
 * ```
 *
 * @example Pass to OqronKit
 * ```ts
 * const adapters = await createAdapters({ mode: 'redis', redis: '...' })
 *
 * await OqronKit.init({
 *   config: {
 *     mode: 'custom',
 *     adapters,
 *     modules: [queueModule(), cronModule()],
 *   },
 * })
 * ```
 */
export async function createAdapters(
  opts: CreateAdaptersOptions,
): Promise<OqronAdapters> {
  if (opts.mode === "custom") {
    return {
      storage: opts.storage,
      broker: opts.broker,
      lock: opts.lock,
      close: async () => {},
    };
  }

  if (opts.mode === "default") {
    const { MemoryStore } = await import("./memory/memory-store.js");
    const { MemoryBroker } = await import("./memory/memory-broker.js");
    const { MemoryLock } = await import("./memory/memory-lock.js");
    return {
      storage: new MemoryStore(),
      broker: new MemoryBroker(),
      lock: new MemoryLock(),
      close: async () => {},
    };
  }

  if (opts.mode === "redis") {
    const { RedisBroker } = await import("./redis/redis-broker.js");
    const { RedisLock } = await import("./redis/redis-lock.js");
    const { RedisStore } = await import("./redis/redis-store.js");

    const { client, owned } = await resolveRedisWithOwnership(opts.redis);
    const prefix = opts.prefix ?? "oqron";

    return {
      storage: new RedisStore(client, prefix),
      broker: new RedisBroker(client, prefix),
      lock: new RedisLock(client, prefix),
      close: async () => {
        if (owned) {
          try {
            await client.quit();
          } catch {
            client.disconnect();
          }
        }
      },
    };
  }

  if (opts.mode === "db") {
    const { PostgresStore } = await import("./postgres/postgres-store.js");
    const { PostgresBroker } = await import("./postgres/postgres-broker.js");
    const { PostgresLock } = await import("./postgres/postgres-lock.js");

    const prefix = opts.postgres.tablePrefix ?? "oqron";
    const pool = opts.postgres.poolSize ?? 10;
    const conn = opts.postgres.connectionString;

    const storage = new PostgresStore(conn, prefix, pool);
    const broker = new PostgresBroker(conn, prefix, pool);
    const lock = new PostgresLock(conn, prefix, pool);

    return {
      storage,
      broker,
      lock,
      close: async () => {
        for (const a of [storage, broker, lock]) {
          try {
            await (a as any).close?.();
          } catch {
            // best-effort
          }
        }
      },
    };
  }

  if (opts.mode === "hybrid-db") {
    const { PostgresStore } = await import("./postgres/postgres-store.js");
    const { RedisBroker } = await import("./redis/redis-broker.js");
    const { RedisLock } = await import("./redis/redis-lock.js");

    const pgPrefix = opts.postgres.tablePrefix ?? "oqron";
    const pgPool = opts.postgres.poolSize ?? 10;
    const storage = new PostgresStore(
      opts.postgres.connectionString,
      pgPrefix,
      pgPool,
    );

    const { client, owned } = await resolveRedisWithOwnership(opts.redis);
    const redisPrefix = opts.redisPrefix ?? "oqron";
    const broker = new RedisBroker(client, redisPrefix);
    const lock = new RedisLock(client, redisPrefix);

    return {
      storage,
      broker,
      lock,
      close: async () => {
        try {
          await (storage as any).close?.();
        } catch {
          // best-effort
        }
        if (owned) {
          try {
            await client.quit();
          } catch {
            client.disconnect();
          }
        }
      },
    };
  }

  throw new Error(`[OqronKit] Unknown adapter mode: ${(opts as any).mode}`);
}

// ── Internal Helpers ────────────────────────────────────────────────────────

/**
 * Resolve a RedisLike value into an ioredis client instance.
 * Handles URL strings, config objects, and pre-initialized clients.
 */
async function resolveRedis(redis: RedisLike): Promise<any> {
  if (typeof redis === "string") {
    const { Redis } = await import("ioredis");
    return new Redis(redis);
  }
  if (redis && typeof redis === "object" && "url" in redis) {
    const { Redis } = await import("ioredis");
    return new Redis((redis as any).url, redis as any);
  }
  // Pre-initialized ioredis client
  return redis;
}

/**
 * Same as resolveRedis, but also tracks whether we created the client
 * (so we know if we should close it on shutdown).
 */
async function resolveRedisWithOwnership(
  redis: RedisLike,
): Promise<{ client: any; owned: boolean }> {
  if (typeof redis === "string") {
    const { Redis } = await import("ioredis");
    return { client: new Redis(redis), owned: true };
  }
  if (redis && typeof redis === "object" && "url" in redis) {
    const { Redis } = await import("ioredis");
    return { client: new Redis((redis as any).url, redis as any), owned: true };
  }
  return { client: redis, owned: false };
}
