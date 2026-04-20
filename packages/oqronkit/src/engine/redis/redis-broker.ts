import type { Redis } from "ioredis";
import type { BrokerStrategy, IBrokerEngine } from "../types/engine.js";

/**
 * Lua: Atomic LPOP + SET lock (FIFO claim — pops from head)
 */
const ATOMIC_CLAIM_FIFO_LUA = `
local id = redis.call("lpop", KEYS[1])
if id == false then return nil end
local lockKey = ARGV[1] .. id
redis.call("set", lockKey, ARGV[2], "PX", ARGV[3], "NX")
return id
`;

/**
 * Lua: Atomic RPOP + SET lock (LIFO claim — pops from tail)
 */
const ATOMIC_CLAIM_LIFO_LUA = `
local id = redis.call("rpop", KEYS[1])
if id == false then return nil end
local lockKey = ARGV[1] .. id
redis.call("set", lockKey, ARGV[2], "PX", ARGV[3], "NX")
return id
`;

/**
 * Lua: Atomic ZPOPMIN + SET lock (Priority claim — lowest score first)
 */
const ATOMIC_CLAIM_PRIORITY_LUA = `
local result = redis.call("zpopmin", KEYS[1], 1)
if #result == 0 then return nil end
local id = result[1]
local lockKey = ARGV[1] .. id
redis.call("set", lockKey, ARGV[2], "PX", ARGV[3], "NX")
return id
`;

/**
 * Lua: Atomic lock extend (check-and-set)
 */
const EXTEND_LOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end
`;

/**
 * Redis implementation of the universal Broker Engine.
 * Supports FIFO, LIFO, and Priority ordering strategies.
 */
export class RedisBroker implements IBrokerEngine {
  constructor(
    private redis: Redis,
    private keyPrefix: string = "oqron",
  ) {}

  private getQueueKey(brokerName: string): string {
    return `${this.keyPrefix}:broker:${brokerName}:queue`;
  }

  private getPriorityKey(brokerName: string): string {
    return `${this.keyPrefix}:broker:${brokerName}:priority`;
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
    priority?: number,
  ): Promise<void> {
    if (delayMs && delayMs > 0) {
      const zkey = this.getDelayedKey(brokerName);
      await this.redis.zadd(zkey, Date.now() + delayMs, id);
    } else if (priority !== undefined) {
      // Priority: store in sorted set with priority as score
      const pkey = this.getPriorityKey(brokerName);
      await this.redis.zadd(pkey, priority, id);
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
    strategy: BrokerStrategy = "fifo",
  ): Promise<string[]> {
    const isPaused = await this.redis.get(this.getPausedKey(brokerName));
    if (isPaused) return [];

    const now = Date.now();
    const zkey = this.getDelayedKey(brokerName);

    // 1. Promote Due Delayed Items
    const dueIds = await this.redis.zrangebyscore(zkey, "-inf", now);
    if (dueIds.length > 0) {
      const pipeline = this.redis.multi();
      if (strategy === "priority") {
        const pkey = this.getPriorityKey(brokerName);
        for (const id of dueIds) pipeline.zadd(pkey, 0, id); // default priority
      } else {
        const qkey = this.getQueueKey(brokerName);
        for (const id of dueIds) pipeline.rpush(qkey, id);
      }
      pipeline.zremrangebyscore(zkey, "-inf", now);
      await pipeline.exec();
    }

    // 2. Select the correct Lua script based on strategy
    let luaScript: string;
    let claimKey: string;

    switch (strategy) {
      case "lifo":
        luaScript = ATOMIC_CLAIM_LIFO_LUA;
        claimKey = this.getQueueKey(brokerName);
        break;
      case "priority":
        luaScript = ATOMIC_CLAIM_PRIORITY_LUA;
        claimKey = this.getPriorityKey(brokerName);
        break;
      default:
        luaScript = ATOMIC_CLAIM_FIFO_LUA;
        claimKey = this.getQueueKey(brokerName);
        break;
    }

    // 3. Atomically claim items
    const claimedIds: string[] = [];
    const lockPrefix = this.getLockPrefix();

    for (let i = 0; i < limit; i++) {
      const id = await this.redis.eval(
        luaScript,
        1,
        claimKey,
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

    const result = await this.redis.eval(
      EXTEND_LOCK_LUA,
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
    const pipeline = this.redis.multi();
    pipeline.del(this.getLockKey(id));

    if (delayMs && delayMs > 0) {
      const zkey = this.getDelayedKey(brokerName);
      pipeline.zadd(zkey, Date.now() + delayMs, id);
    } else {
      const qkey = this.getQueueKey(brokerName);
      pipeline.lpush(qkey, id);
    }

    await pipeline.exec();
  }

  async pause(brokerName: string): Promise<void> {
    await this.redis.set(this.getPausedKey(brokerName), "1");
  }

  async resume(brokerName: string): Promise<void> {
    await this.redis.del(this.getPausedKey(brokerName));
  }

  /**
   * Blocking claim using BLPOP/BRPOP — waits up to `timeoutMs` for a job.
   * Zero CPU usage while waiting. Sub-ms latency when a job arrives.
   *
   * For priority strategy, falls back to non-blocking ZPOPMIN since
   * sorted sets don't support blocking pops natively.
   */
  async claimBlocking(
    brokerName: string,
    consumerId: string,
    lockTtlMs: number,
    timeoutMs: number,
    strategy: BrokerStrategy = "fifo",
  ): Promise<string | null> {
    const isPaused = await this.redis.get(this.getPausedKey(brokerName));
    if (isPaused) return null;

    // Promote delayed items first
    const now = Date.now();
    const zkey = this.getDelayedKey(brokerName);
    const dueIds = await this.redis.zrangebyscore(zkey, "-inf", now);
    if (dueIds.length > 0) {
      const pipeline = this.redis.multi();
      if (strategy === "priority") {
        const pkey = this.getPriorityKey(brokerName);
        for (const id of dueIds) pipeline.zadd(pkey, 0, id);
      } else {
        const qkey = this.getQueueKey(brokerName);
        for (const id of dueIds) pipeline.rpush(qkey, id);
      }
      pipeline.zremrangebyscore(zkey, "-inf", now);
      await pipeline.exec();
    }

    // Priority: no blocking pop for sorted sets — use non-blocking fallback
    if (strategy === "priority") {
      const claimed = await this.claim(brokerName, consumerId, 1, lockTtlMs, "priority");
      return claimed[0] ?? null;
    }

    // FIFO: BLPOP (pops from head), LIFO: BRPOP (pops from tail)
    const qkey = this.getQueueKey(brokerName);
    const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));

    const result = strategy === "lifo"
      ? await this.redis.brpop(qkey, timeoutSec)
      : await this.redis.blpop(qkey, timeoutSec);

    if (!result) return null;

    const id = result[1]; // BLPOP returns [key, value]

    // Atomically set the lock
    const lockKey = this.getLockKey(id);
    await this.redis.set(lockKey, consumerId, "PX", lockTtlMs, "NX");

    return id;
  }

  /**
   * Atomic state transition using Redis Lua script.
   * Combines storage save + broker nack/ack in a single atomic operation.
   * Only works when BOTH storage and broker are Redis (same database).
   */
  async atomicTransition(
    brokerName: string,
    jobId: string,
    jobData: Record<string, any>,
    action: "nack" | "ack",
    delayMs?: number,
  ): Promise<void> {
    const storageKey = "oqron:storage:jobs"; // Assuming default Redis storage key
    const lockKey = this.getLockKey(jobId);
    const qkey = this.getQueueKey(brokerName);
    const zkey = this.getDelayedKey(brokerName);

    const jobJson = JSON.stringify(jobData);
    const runAt = delayMs ? Date.now() + delayMs : 0;

    // LUA Script:
    // KEYS[1] = storage hash, KEYS[2] = lock key, KEYS[3] = queue list, KEYS[4] = delayed zset
    // ARGV[1] = jobId, ARGV[2] = jobJson, ARGV[3] = action, ARGV[4] = runAt
    const lua = `
      redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
      redis.call("DEL", KEYS[2])
      if ARGV[3] == "nack" then
        local runAt = tonumber(ARGV[4])
        if runAt > 0 then
          redis.call("ZADD", KEYS[4], runAt, ARGV[1])
        else
          redis.call("LPUSH", KEYS[3], ARGV[1])
        end
      end
      return 1
    `;

    await this.redis.eval(
      lua,
      4,
      storageKey, lockKey, qkey, zkey,
      jobId, jobJson, action, runAt.toString()
    );
  }
}
