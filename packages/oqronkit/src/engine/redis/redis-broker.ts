import type { Redis } from "ioredis";
import type { IBrokerEngine } from "../types/engine.js";

/**
 * Lua script for atomic LPOP + SET lock.
 * Pops a single item from the queue list and atomically sets a lock key.
 * Returns the popped ID or nil if the queue is empty.
 *
 * KEYS[1] = queue list key
 * ARGV[1] = lock key prefix
 * ARGV[2] = consumerId
 * ARGV[3] = lockTtlMs
 * Returns: popped ID or nil
 */
const ATOMIC_CLAIM_LUA = `
local id = redis.call("lpop", KEYS[1])
if id == false then
  return nil
end
local lockKey = ARGV[1] .. id
redis.call("set", lockKey, ARGV[2], "PX", ARGV[3], "NX")
return id
`;

/**
 * Redis implementation of the universal Broker Engine.
 * Provides high-throughput, cross-node lock orchestration and signaling.
 */
export class RedisBroker implements IBrokerEngine {
  constructor(
    private redis: Redis,
    private keyPrefix: string = "oqron",
  ) {}

  private getQueueKey(brokerName: string): string {
    return `${this.keyPrefix}:broker:${brokerName}:queue`;
  }

  private getDelayedKey(brokerName: string): string {
    return `${this.keyPrefix}:broker:${brokerName}:delayed`;
  }

  private getLockKey(id: string): string {
    return `${this.keyPrefix}:lock:${id}`;
  }

  private getLockPrefix(): string {
    return `${this.keyPrefix}:lock:`;
  }

  private getPausedKey(brokerName: string): string {
    return `${this.keyPrefix}:broker:${brokerName}:paused`;
  }

  async publish(
    brokerName: string,
    id: string,
    delayMs?: number,
  ): Promise<void> {
    if (delayMs && delayMs > 0) {
      const zkey = this.getDelayedKey(brokerName);
      await this.redis.zadd(zkey, Date.now() + delayMs, id);
    } else {
      const qkey = this.getQueueKey(brokerName);
      await this.redis.rpush(qkey, id);
    }
  }

  async claim(
    brokerName: string,
    consumerId: string,
    limit: number,
    lockTtlMs: number,
  ): Promise<string[]> {
    const isPaused = await this.redis.get(this.getPausedKey(brokerName));
    if (isPaused) return [];

    const now = Date.now();
    const qkey = this.getQueueKey(brokerName);
    const zkey = this.getDelayedKey(brokerName);

    // 1. Promote Due Delayed Items to end of queue list
    const dueIds = await this.redis.zrangebyscore(zkey, "-inf", now);
    if (dueIds.length > 0) {
      const pipeline = this.redis.multi();
      for (const id of dueIds) pipeline.rpush(qkey, id);
      pipeline.zremrangebyscore(zkey, "-inf", now);
      await pipeline.exec();
    }

    // 2. Atomically claim: LPOP + SET lock in a single Lua call per item
    //    This prevents the race where a pop succeeds but the lock fails,
    //    which would orphan the job.
    const claimedIds: string[] = [];
    const lockPrefix = this.getLockPrefix();

    for (let i = 0; i < limit; i++) {
      const id = await this.redis.eval(
        ATOMIC_CLAIM_LUA,
        1,
        qkey,
        lockPrefix,
        consumerId,
        lockTtlMs,
      );
      if (id === null || id === undefined) break;
      claimedIds.push(id as string);
    }

    return claimedIds;
  }

  async extendLock(
    id: string,
    consumerId: string,
    lockTtlMs: number,
  ): Promise<void> {
    const lockKey = this.getLockKey(id);

    // Lua script to ensure atomic check-and-set for extend
    const luaScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("pexpire", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;

    const result = await this.redis.eval(
      luaScript,
      1,
      lockKey,
      consumerId,
      lockTtlMs,
    );

    if (result !== 1) {
      throw new Error(`Lock lost or stolen for entity ${id}`);
    }
  }

  async ack(_brokerName: string, id: string): Promise<void> {
    await this.redis.del(this.getLockKey(id));
  }

  async nack(brokerName: string, id: string, delayMs?: number): Promise<void> {
    // Release lock and re-queue at the broker level (crash-safe retry)
    const pipeline = this.redis.multi();
    pipeline.del(this.getLockKey(id));

    if (delayMs && delayMs > 0) {
      const zkey = this.getDelayedKey(brokerName);
      pipeline.zadd(zkey, Date.now() + delayMs, id);
    } else {
      const qkey = this.getQueueKey(brokerName);
      pipeline.lpush(qkey, id); // Push to front for immediate retry
    }

    await pipeline.exec();
  }

  async pause(brokerName: string): Promise<void> {
    await this.redis.set(this.getPausedKey(brokerName), "1");
  }

  async resume(brokerName: string): Promise<void> {
    await this.redis.del(this.getPausedKey(brokerName));
  }
}
