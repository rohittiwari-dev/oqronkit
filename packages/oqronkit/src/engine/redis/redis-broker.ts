import type { Redis } from "ioredis";
import type { IBrokerEngine } from "../types/engine.js";

/**
 * Redis implementation of the universal Broker Engine.
 *
 * Provides extremely high-throughput, cross-node lock orchestration and signaling
 * exactly similar to BullMQ's core runtime methodology.
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

    // 2. Claim up to `limit` from queue list Left side (FIFO)
    // ioredis lpop can pop count in Redis >= 6.2.0
    // OqronKit relies strictly on native primitives.
    const pipelinePop = this.redis.multi();
    // Simulate multi-lpop if count > 1
    for (let i = 0; i < limit; i++) {
      pipelinePop.lpop(qkey);
    }
    const popResults = await pipelinePop.exec();

    // Filter out nulls from pop
    const claimedIds: string[] = [];
    if (popResults) {
      for (const [err, res] of popResults) {
        if (!err && res) claimedIds.push(res as string);
      }
    }

    if (claimedIds.length === 0) return [];

    // 3. Atomically Lock using SET NX PX internally structured as robust heartbeats
    const pipelineLock = this.redis.multi();
    for (const cid of claimedIds) {
      // SET key val NX PX ttl
      pipelineLock.set(this.getLockKey(cid), consumerId, "PX", lockTtlMs, "NX");
    }

    await pipelineLock.exec();

    // Any locks that failed to set NX usually indicate a zombie job running elsewhere,
    // but queue pops are destructive, so collisions only happen on aggressive network partitions.

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

  async pause(brokerName: string): Promise<void> {
    await this.redis.set(this.getPausedKey(brokerName), "1");
  }

  async resume(brokerName: string): Promise<void> {
    await this.redis.del(this.getPausedKey(brokerName));
  }
}
