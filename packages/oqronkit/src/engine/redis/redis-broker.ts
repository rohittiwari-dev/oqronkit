import type { Redis } from "ioredis";
import type { BrokerStrategy, IBrokerEngine } from "../types/engine.js";

/**
 * Lua: Atomic LPOP + SET lock (FIFO claim — pops from head)
 */
const ATOMIC_CLAIM_FIFO_LUA = `
local id = redis.call("lpop", KEYS[1])
if id == false then return nil end
local lockKey = ARGV[1] .. id
local locked = redis.call("set", lockKey, ARGV[2], "PX", ARGV[3], "NX")
if locked then
  redis.call("sadd", ARGV[4] .. ARGV[2] .. ":" .. id, ARGV[5])
  redis.call("pexpire", ARGV[4] .. ARGV[2] .. ":" .. id, ARGV[3])
  return id
end
redis.call("lpush", KEYS[1], id)
return nil
`;

/**
 * Lua: Atomic RPOP + SET lock (LIFO claim — pops from tail)
 */
const ATOMIC_CLAIM_LIFO_LUA = `
local id = redis.call("rpop", KEYS[1])
if id == false then return nil end
local lockKey = ARGV[1] .. id
local locked = redis.call("set", lockKey, ARGV[2], "PX", ARGV[3], "NX")
if locked then
  redis.call("sadd", ARGV[4] .. ARGV[2] .. ":" .. id, ARGV[5])
  redis.call("pexpire", ARGV[4] .. ARGV[2] .. ":" .. id, ARGV[3])
  return id
end
redis.call("rpush", KEYS[1], id)
return nil
`;

/**
 * Lua: Atomic ZPOPMIN + SET lock (Priority claim — lowest score first)
 */
const ATOMIC_CLAIM_PRIORITY_LUA = `
local result = redis.call("zpopmin", KEYS[1], 1)
if #result == 0 then return nil end
local id = result[1]
local score = result[2]
local lockKey = ARGV[1] .. id
local locked = redis.call("set", lockKey, ARGV[2], "PX", ARGV[3], "NX")
if locked then
  redis.call("sadd", ARGV[4] .. ARGV[2] .. ":" .. id, ARGV[5])
  redis.call("pexpire", ARGV[4] .. ARGV[2] .. ":" .. id, ARGV[3])
  return id
end
redis.call("zadd", KEYS[1], score, id)
return nil
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

  private getDelayedPriorityKey(brokerName: string): string {
    return `${this.keyPrefix}:broker:${brokerName}:delayed-priority`;
  }

  private getLockKey(brokerName: string, id: string): string {
    return `${this.keyPrefix}:broker:${brokerName}:lock:${id}`;
  }

  private getLockPrefix(brokerName: string): string {
    return `${this.keyPrefix}:broker:${brokerName}:lock:`;
  }

  private getLockIndexKey(id: string, consumerId: string): string {
    return `${this.getLockIndexPrefix()}${consumerId}:${id}`;
  }

  private getLockIndexPrefix(): string {
    return `${this.keyPrefix}:lock-index:`;
  }

  private getPausedKey(brokerName: string): string {
    return `${this.keyPrefix}:broker:${brokerName}:paused`;
  }

  private async removeQueuedId(brokerName: string, id: string): Promise<void> {
    await this.redis
      .multi()
      .lrem(this.getQueueKey(brokerName), 0, id)
      .zrem(this.getPriorityKey(brokerName), id)
      .zrem(this.getDelayedKey(brokerName), id)
      .hdel(this.getDelayedPriorityKey(brokerName), id)
      .exec();
  }

  private async promoteDueDelayed(
    brokerName: string,
    strategy: BrokerStrategy,
  ): Promise<void> {
    const now = Date.now();
    const zkey = this.getDelayedKey(brokerName);
    const dueIds = await this.redis.zrangebyscore(zkey, "-inf", now);
    if (dueIds.length === 0) return;

    const priorityKey = this.getDelayedPriorityKey(brokerName);
    const priorityValues = await this.redis.hmget(priorityKey, ...dueIds);
    const pipeline = this.redis.multi();
    if (strategy === "priority") {
      const pkey = this.getPriorityKey(brokerName);
      for (let i = 0; i < dueIds.length; i++) {
        const priority = Number(priorityValues[i] ?? 0);
        pipeline.zadd(
          pkey,
          Number.isFinite(priority) ? priority : 0,
          dueIds[i],
        );
      }
    } else {
      const qkey = this.getQueueKey(brokerName);
      for (const id of dueIds) pipeline.rpush(qkey, id);
    }
    pipeline.zremrangebyscore(zkey, "-inf", now);
    pipeline.hdel(priorityKey, ...dueIds);
    await pipeline.exec();
  }

  private async nextDelayedDueInMs(brokerName: string): Promise<number | null> {
    const rows = await this.redis.zrange(
      this.getDelayedKey(brokerName),
      0,
      0,
      "WITHSCORES",
    );
    if (rows.length < 2) return null;
    const dueAt = Number(rows[1]);
    if (!Number.isFinite(dueAt)) return null;
    return Math.max(0, dueAt - Date.now());
  }

  async publish(
    brokerName: string,
    id: string,
    delayMs?: number,
    priority?: number,
  ): Promise<void> {
    await this.removeQueuedId(brokerName, id);
    if (delayMs && delayMs > 0) {
      const zkey = this.getDelayedKey(brokerName);
      const pipeline = this.redis.multi().zadd(zkey, Date.now() + delayMs, id);
      if (priority !== undefined) {
        pipeline.hset(this.getDelayedPriorityKey(brokerName), id, priority);
      }
      await pipeline.exec();
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

    // 1. Promote Due Delayed Items
    await this.promoteDueDelayed(brokerName, strategy);

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
    const lockPrefix = this.getLockPrefix(brokerName);
    const lockIndexPrefix = this.getLockIndexPrefix();

    for (let i = 0; i < limit; i++) {
      const id = await this.redis.eval(
        luaScript,
        1,
        claimKey,
        lockPrefix,
        consumerId,
        lockTtlMs,
        lockIndexPrefix,
        brokerName,
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
    brokerNameOverride?: string,
  ): Promise<void> {
    let brokerName = brokerNameOverride;
    if (!brokerName) {
      const brokerNames = await this.redis.smembers(
        this.getLockIndexKey(id, consumerId),
      );
      if (brokerNames.length > 1) {
        throw new Error(
          `Ambiguous lock for entity ${id}; broker name is required`,
        );
      }
      brokerName = brokerNames[0];
    }

    const lockKey = brokerName
      ? this.getLockKey(brokerName, id)
      : `${this.keyPrefix}:lock:${id}`;

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
    if (brokerName) {
      await this.redis.pexpire(this.getLockIndexKey(id, consumerId), lockTtlMs);
    }
  }

  async ack(brokerName: string, id: string): Promise<void> {
    const consumerId = await this.redis.get(this.getLockKey(brokerName, id));
    const pipeline = this.redis
      .multi()
      .del(this.getLockKey(brokerName, id))
      .lrem(this.getQueueKey(brokerName), 0, id)
      .zrem(this.getPriorityKey(brokerName), id)
      .zrem(this.getDelayedKey(brokerName), id)
      .hdel(this.getDelayedPriorityKey(brokerName), id);
    if (consumerId) {
      pipeline.srem(this.getLockIndexKey(id, consumerId), brokerName);
    }
    await pipeline.exec();
  }

  async nack(
    brokerName: string,
    id: string,
    delayMs?: number,
    priority?: number,
  ): Promise<void> {
    const consumerId = await this.redis.get(this.getLockKey(brokerName, id));
    const pipeline = this.redis.multi();
    pipeline.del(this.getLockKey(brokerName, id));
    if (consumerId) {
      pipeline.srem(this.getLockIndexKey(id, consumerId), brokerName);
    }
    pipeline.lrem(this.getQueueKey(brokerName), 0, id);
    pipeline.zrem(this.getPriorityKey(brokerName), id);
    pipeline.zrem(this.getDelayedKey(brokerName), id);
    pipeline.hdel(this.getDelayedPriorityKey(brokerName), id);

    if (delayMs && delayMs > 0) {
      const zkey = this.getDelayedKey(brokerName);
      pipeline.zadd(zkey, Date.now() + delayMs, id);
      if (priority !== undefined) {
        pipeline.hset(this.getDelayedPriorityKey(brokerName), id, priority);
      }
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
    await this.promoteDueDelayed(brokerName, strategy);

    // Priority: no blocking pop for sorted sets — use non-blocking fallback
    if (strategy === "priority") {
      const claimed = await this.claim(
        brokerName,
        consumerId,
        1,
        lockTtlMs,
        "priority",
      );
      if (claimed[0]) return claimed[0];
      const dueInMs = await this.nextDelayedDueInMs(brokerName);
      if (dueInMs === null || dueInMs > timeoutMs) return null;
      await new Promise((resolve) => setTimeout(resolve, dueInMs));
      const delayedClaim = await this.claim(
        brokerName,
        consumerId,
        1,
        lockTtlMs,
        "priority",
      );
      return delayedClaim[0] ?? null;
    }

    // FIFO: BLPOP (pops from head), LIFO: BRPOP (pops from tail)
    const qkey = this.getQueueKey(brokerName);
    const dueInMs = await this.nextDelayedDueInMs(brokerName);
    const timeoutSec = Math.max(
      1,
      Math.ceil(Math.min(timeoutMs, dueInMs ?? timeoutMs) / 1000),
    );

    const result =
      strategy === "lifo"
        ? await this.redis.brpop(qkey, timeoutSec)
        : await this.redis.blpop(qkey, timeoutSec);

    if (!result) {
      await this.promoteDueDelayed(brokerName, strategy);
      const claimed = await this.claim(
        brokerName,
        consumerId,
        1,
        lockTtlMs,
        strategy,
      );
      return claimed[0] ?? null;
    }

    const id = result[1]; // BLPOP returns [key, value]

    // Re-check pause state — queue could have been paused during blocking wait
    const stillPaused = await this.redis.get(this.getPausedKey(brokerName));
    if (stillPaused) {
      // Push the item back and return null
      await this.redis[strategy === "lifo" ? "rpush" : "lpush"](qkey, id);
      return null;
    }

    // Atomically set the lock
    const lockKey = this.getLockKey(brokerName, id);
    const locked = await this.redis.set(
      lockKey,
      consumerId,
      "PX",
      lockTtlMs,
      "NX",
    );
    if (locked !== "OK") {
      if (strategy === "lifo") {
        await this.redis.rpush(qkey, id);
      } else {
        await this.redis.lpush(qkey, id);
      }
      return null;
    }
    const indexKey = this.getLockIndexKey(id, consumerId);
    await this.redis
      .multi()
      .sadd(indexKey, brokerName)
      .pexpire(indexKey, lockTtlMs)
      .exec();

    return id;
  }
}
