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

/**
 * Bootstraps the engines dynamically based on config.
 * Connects to Redis for multi-node scaling or falls back to in-memory.
 */
export async function initEngine(config: OqronConfig): Promise<void> {
  if (config.redis) {
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
  } else {
    _redisClient = null;
    _redisClientOwned = false;
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
  if (_redisClient && _redisClientOwned) {
    try {
      await _redisClient.quit();
    } catch {
      // Best-effort — the process may already be exiting
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
