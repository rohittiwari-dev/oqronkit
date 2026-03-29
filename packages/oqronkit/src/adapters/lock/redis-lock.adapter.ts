import type { ILockAdapter } from "../../core/index.js";

/**
 * RedisLockAdapter — High-performance distributed lock adapter using Redis.
 *
 * Uses the industry-standard `SET NX PX` atomic command for lock acquisition
 * and Lua scripts for atomic release/renewal (same pattern as BullMQ, Redlock).
 *
 * Accepts any `ioredis`-compatible client.
 *
 * Usage:
 * ```ts
 * import Redis from "ioredis";
 * import { RedisLockAdapter } from "oqronkit";
 *
 * const redis = new Redis("redis://localhost:6379");
 * const lock = new RedisLockAdapter(redis);
 * ```
 */
export class RedisLockAdapter implements ILockAdapter {
  constructor(
    private readonly redis: {
      set(...args: any[]): Promise<string | null>;
      get(key: string): Promise<string | null>;
      del(...keys: string[]): Promise<number>;
      eval(...args: any[]): Promise<any>;
      pttl(key: string): Promise<number>;
    },
    private readonly defaultTtlMs: number = 30_000,
    private readonly keyPrefix: string = "oqron:lock:",
  ) {}

  private key(resourceKey: string): string {
    return `${this.keyPrefix}${resourceKey}`;
  }

  /**
   * Acquire a lock atomically using SET NX PX.
   * - NX = only set if NOT exists
   * - PX = auto-expire after ttlMs milliseconds
   * This is a single atomic Redis command — sub-millisecond.
   */
  async acquire(
    key: string,
    ownerId: string,
    ttlMs?: number,
  ): Promise<boolean> {
    const finalTtl = ttlMs ?? this.defaultTtlMs;
    const result = await this.redis.set(
      this.key(key),
      ownerId,
      "PX",
      finalTtl,
      "NX",
    );
    return result === "OK";
  }

  /**
   * Renew a lock atomically using a Lua script.
   * Only extends the TTL if the current owner matches (prevents stealing).
   */
  async renew(key: string, ownerId: string, ttlMs?: number): Promise<boolean> {
    const finalTtl = ttlMs ?? this.defaultTtlMs;
    // Lua script: if the value matches ownerId, extend the TTL
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("pexpire", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;
    const result = await this.redis.eval(
      script,
      1,
      this.key(key),
      ownerId,
      finalTtl,
    );
    return result === 1;
  }

  /**
   * Release a lock atomically using a Lua script.
   * Only deletes the key if the current owner matches (prevents releasing someone else's lock).
   */
  async release(key: string, ownerId: string): Promise<void> {
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    await this.redis.eval(script, 1, this.key(key), ownerId);
  }

  /**
   * Check if the lock is currently held by the given owner.
   */
  async isOwner(key: string, ownerId: string): Promise<boolean> {
    const currentOwner = await this.redis.get(this.key(key));
    if (currentOwner !== ownerId) return false;
    // Also check TTL — if it's expired or being evicted, we don't own it
    const ttl = await this.redis.pttl(this.key(key));
    return ttl > 0;
  }
}
