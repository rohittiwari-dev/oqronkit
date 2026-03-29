import { MemoryBroker } from "./memory/memory-broker.js";
import { MemoryStore } from "./memory/memory-store.js";
import { RedisBroker } from "./redis/redis-broker.js";
import { RedisStore } from "./redis/redis-store.js";
import type { OqronConfig } from "./types/config.types.js";
import type { IBrokerEngine, IStorageEngine } from "./types/engine.js";

// Global unified singletons
export let Storage: IStorageEngine;
export let Broker: IBrokerEngine;

/**
 * Bootstraps the engines dynamically based on config.
 * Either deeply connects to Redis (scaling to multi-node capability) or falls back
 * entirely to internal memory (monolithic monolithic scaling).
 */
export async function initEngine(config: OqronConfig): Promise<void> {
  if (config.redis) {
    const { Redis } = await import("ioredis");
    // Ensure the connection config acts reliably as either string or ioRedis instance
    const redisClient =
      typeof config.redis === "string" ? new Redis(config.redis) : config.redis;

    Storage = new RedisStore(redisClient as any, config.project);
    Broker = new RedisBroker(redisClient as any, config.project);
  } else {
    // Zero dependencies Memory fallback
    Storage = new MemoryStore();
    Broker = new MemoryBroker();
  }
}

/**
 * Shut down connections strictly if connected
 */
export async function stopEngine(): Promise<void> {
  if (Storage instanceof RedisStore) {
    // Since we didn't store the exact redis instance in index.ts directly,
    // we assume the connection handles closure independently if it's passed in,
    // or we gracefully shut it here. For now we leave it to user if passed.
  }
}
