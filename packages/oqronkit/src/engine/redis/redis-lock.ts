import type { Redis } from "ioredis";
import type { ILockAdapter } from "../types/engine.js";

const RENEW_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end
`;

const RELEASE_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

export class RedisLock implements ILockAdapter {
  constructor(
    private readonly redis: Redis,
    private readonly project: string = "oqronkit",
  ) {}

  private key(k: string) {
    return `${this.project}:locks:${k}`;
  }

  async acquire(key: string, ownerId: string, ttlMs: number): Promise<boolean> {
    const k = this.key(key);
    const result = await this.redis.set(k, ownerId, "PX", ttlMs, "NX");
    if (result === "OK") return true;

    // Check if we already own it
    const currentOwner = await this.redis.get(k);
    if (currentOwner === ownerId) {
      // Refresh TTL
      await this.redis.pexpire(k, ttlMs);
      return true;
    }
    return false;
  }

  async renew(key: string, ownerId: string, ttlMs: number): Promise<boolean> {
    const k = this.key(key);
    const res = await this.redis.eval(
      RENEW_LUA,
      1,
      k,
      ownerId,
      ttlMs.toString(),
    );
    return res === 1;
  }

  async release(key: string, ownerId: string): Promise<void> {
    const k = this.key(key);
    await this.redis.eval(RELEASE_LUA, 1, k, ownerId);
  }

  async isOwner(key: string, ownerId: string): Promise<boolean> {
    const k = this.key(key);
    const current = await this.redis.get(k);
    return current === ownerId;
  }
}
