import { MemoryBroker } from "./memory/memory-broker.js";
import { MemoryLock } from "./memory/memory-lock.js";
import { MemoryStore } from "./memory/memory-store.js";
import { RedisBroker } from "./redis/redis-broker.js";
import { RedisLock } from "./redis/redis-lock.js";
import { RedisStore } from "./redis/redis-store.js";
import type { OqronConfig } from "./types/config.types.js";
import type {
  IBrokerEngine,
  ILockAdapter,
  IStorageEngine,
} from "./types/engine.js";

// Global unified singletons
export let Storage: IStorageEngine;
export let Broker: IBrokerEngine;
export let Lock: ILockAdapter;

/**
 * Hold a reference to the Redis client so we can cleanly disconnect on shutdown.
 * If the user passed an existing ioredis instance, we track it but do NOT
 * force-close it — the user owns its lifecycle.
 */
let _redisClient: any = null;
let _redisClientOwned = false; // true only when WE created it from a URL string
/** PostgreSQL adapters tracked for pool close on shutdown */
let _pgAdapters: Array<{ close(): Promise<void> }> | null = null;

/**
 * Bootstraps the engines dynamically based on config.
 * Priority: postgres > redis > memory (in-process monolith).
 */
export async function initEngine(config: OqronConfig): Promise<void> {
  if (config.postgres) {
    // ── PostgreSQL Adapters ────────────────────────────────────────────────
    const { PostgresStore } = await import("./postgres/postgres-store.js");
    const { PostgresBroker } = await import("./postgres/postgres-broker.js");
    const { PostgresLock } = await import("./postgres/postgres-lock.js");

    const prefix = config.postgres.tablePrefix ?? "oqron";
    const pool = config.postgres.poolSize ?? 10;
    const conn = config.postgres.connectionString;

    Storage = new PostgresStore(conn, prefix, pool);
    Broker = new PostgresBroker(conn, prefix, pool);
    Lock = new PostgresLock(conn, prefix, pool);

    _pgAdapters = [Storage, Broker, Lock] as any[];
    _redisClient = null;
    _redisClientOwned = false;
  } else if (config.redis) {
    // ── Redis Adapters ─────────────────────────────────────────────────────
    const { Redis } = await import("ioredis");

    if (typeof config.redis === "string") {
      _redisClient = new Redis(config.redis);
      _redisClientOwned = true;
    } else {
      _redisClient = config.redis;
      _redisClientOwned = false;
    }

    Storage = new RedisStore(_redisClient, config.project);
    Broker = new RedisBroker(_redisClient, config.project);
    Lock = new RedisLock(_redisClient, config.project);
    _pgAdapters = null;
  } else {
    // ── Memory Adapters (monolith / development) ───────────────────────────
    _redisClient = null;
    _redisClientOwned = false;
    _pgAdapters = null;
    Storage = new MemoryStore();
    Broker = new MemoryBroker();
    Lock = new MemoryLock();
  }
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
        /* best-effort */
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
        /* swallow */
      }
    }
  }
  _redisClient = null;
  _redisClientOwned = false;
}
