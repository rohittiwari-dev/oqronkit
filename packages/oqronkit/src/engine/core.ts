import { OqronContainer } from "./container.js";
import { MemoryBroker } from "./memory/memory-broker.js";
import { MemoryLock } from "./memory/memory-lock.js";
import { MemoryStore } from "./memory/memory-store.js";
import type { OqronConfig, OqronStorageMode } from "./types/config.types.js";
import type {
  IBrokerEngine,
  ILockAdapter,
  IStorageEngine,
} from "./types/engine.js";

// ── Backward-Compatible Global Accessors ────────────────────────────────────
// These proxy objects delegate all property access to the container singleton.
// Existing code that imports `Storage`, `Broker`, `Lock` will continue to work
// without any changes — including destructured imports.

function createProxy<T extends object>(accessor: () => T): T {
  return new Proxy({} as T, {
    get(_target, prop, receiver) {
      const real = accessor();
      const val = Reflect.get(real, prop, receiver);
      return typeof val === "function" ? val.bind(real) : val;
    },
  });
}

export const Storage: IStorageEngine = createProxy(
  () => OqronContainer.get().storage,
);
export const Broker: IBrokerEngine = createProxy(
  () => OqronContainer.get().broker,
);
export const Lock: ILockAdapter = createProxy(() => OqronContainer.get().lock);

// ── Internal state for owned connections ────────────────────────────────────

/**
 * Hold a reference to the Redis client so we can cleanly disconnect on shutdown.
 * If the user passed an existing ioredis instance, we track it but do NOT
 * force-close it — the user owns its lifecycle.
 */
let _redisClient: any = null;
let _redisClientOwned = false; // true only when WE created it from a URL string

import type { ICloseable } from "./types/engine.js";

/** PostgreSQL adapters tracked for pool close on shutdown */
let _pgAdapters: ICloseable[] | null = null;

/**
 * Bootstraps the engines dynamically based on `config.mode`.
 *
 * Mode resolution:
 * - `"default"` (or omitted) → Memory (all three: storage, broker, lock)
 * - `"db"` → PostgreSQL (all three). Requires `config.postgres`.
 * - `"redis"` → Redis (all three). Requires `config.redis`.
 * - `"hybrid-db"` → PG (storage) + Redis (broker + lock). Requires both.
 */
export async function initEngine(config: OqronConfig): Promise<void> {
  let storage: IStorageEngine;
  let broker: IBrokerEngine;
  let lock: ILockAdapter;

  const mode: OqronStorageMode = config.mode ?? "default";

  if (mode === "hybrid-db") {
    // ── Hybrid: PG (storage) + Redis (broker + lock) ──────────────────────
    if (!config.postgres) {
      throw new Error(
        '[OqronKit] mode "hybrid-db" requires `postgres` config for durable storage.',
      );
    }
    if (!config.redis) {
      throw new Error(
        '[OqronKit] mode "hybrid-db" requires `redis` config for broker + lock.',
      );
    }

    const { PostgresStore } = await import("./postgres/postgres-store.js");
    const { RedisBroker } = await import("./redis/redis-broker.js");
    const { RedisLock } = await import("./redis/redis-lock.js");
    const { Redis } = await import("ioredis");

    const prefix = config.postgres.tablePrefix ?? "oqron";
    const pool = config.postgres.poolSize ?? 10;
    const conn = config.postgres.connectionString;

    storage = new PostgresStore(conn, prefix, pool);
    _pgAdapters = [storage as unknown as ICloseable];

    // Redis for broker + lock
    if (typeof config.redis === "string") {
      _redisClient = new Redis(config.redis);
      _redisClientOwned = true;
    } else if (config.redis && (config.redis as any).url) {
      _redisClient = new Redis((config.redis as any).url, config.redis as any);
      _redisClientOwned = true;
    } else {
      _redisClient = config.redis;
      _redisClientOwned = false;
    }

    const redisPrefix = `${config.project}:${config.environment ?? "development"}`;
    broker = new RedisBroker(_redisClient, redisPrefix);
    lock = new RedisLock(_redisClient, redisPrefix);
  } else if (mode === "db") {
    // ── PostgreSQL Adapters ──────────────────────────────────────────────
    if (!config.postgres) {
      throw new Error('[OqronKit] mode "db" requires `postgres` config.');
    }

    const { PostgresStore } = await import("./postgres/postgres-store.js");
    const { PostgresBroker } = await import("./postgres/postgres-broker.js");
    const { PostgresLock } = await import("./postgres/postgres-lock.js");

    const prefix = config.postgres.tablePrefix ?? "oqron";
    const pool = config.postgres.poolSize ?? 10;
    const conn = config.postgres.connectionString;

    storage = new PostgresStore(conn, prefix, pool);
    broker = new PostgresBroker(conn, prefix, pool);
    lock = new PostgresLock(conn, prefix, pool);

    _pgAdapters = [storage, broker, lock] as unknown as ICloseable[];
    _redisClient = null;
    _redisClientOwned = false;
  } else if (mode === "redis") {
    // ── Redis Adapters ──────────────────────────────────────────────────
    if (!config.redis) {
      throw new Error('[OqronKit] mode "redis" requires `redis` config.');
    }

    const { RedisBroker } = await import("./redis/redis-broker.js");
    const { RedisLock } = await import("./redis/redis-lock.js");
    const { RedisStore } = await import("./redis/redis-store.js");
    const { Redis } = await import("ioredis");

    if (typeof config.redis === "string") {
      _redisClient = new Redis(config.redis);
      _redisClientOwned = true;
    } else if (config.redis && (config.redis as any).url) {
      _redisClient = new Redis((config.redis as any).url, config.redis as any);
      _redisClientOwned = true;
    } else {
      _redisClient = config.redis;
      _redisClientOwned = false;
    }

    const prefix = `${config.project}:${config.environment ?? "development"}`;
    storage = new RedisStore(_redisClient, prefix);
    broker = new RedisBroker(_redisClient, prefix);
    lock = new RedisLock(_redisClient, prefix);
    _pgAdapters = null;
  } else {
    // ── Memory Adapters (default — monolith / development) ──────────────
    _redisClient = null;
    _redisClientOwned = false;
    _pgAdapters = null;
    storage = new MemoryStore();
    broker = new MemoryBroker();
    lock = new MemoryLock();
  }

  // Initialize the DI container — both the global singleton and the proxy shims
  OqronContainer.init(storage, broker, lock, config);
}

/**
 * Gracefully shut down adapter connections.
 * Only closes the Redis client if OqronKit created it from a URL string.
 * User-supplied instances are left open for the caller to manage.
 */
export async function stopEngine(): Promise<void> {
  // Close PostgreSQL connection pools
  if (_pgAdapters) {
    for (const adapter of _pgAdapters) {
      try {
        await adapter.close();
      } catch {
        // best-effort: PG adapter close failed during shutdown — non-critical
      }
    }
    _pgAdapters = null;
  }

  // Close Redis client if we own it
  if (_redisClient && _redisClientOwned) {
    try {
      await _redisClient.quit();
    } catch {
      try {
        _redisClient.disconnect();
      } catch {
        // best-effort: Redis disconnect failed during shutdown — non-critical
      }
    }
  }
  _redisClient = null;
  _redisClientOwned = false;

  // Reset the DI container
  OqronContainer.reset();
}
