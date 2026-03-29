import type { Redis } from "ioredis";
import type { IStorageEngine, ListOptions } from "../types/engine.js";

/**
 * Redis implementation of the universal Storage Engine.
 *
 * Uses single JSON blobs per key (SET/GET) instead of HSET field-flattening,
 * eliminating heuristic deserialization bugs. A ZSET index enables sorted
 * listing and pagination.
 *
 * Key schema:
 *   Data:  `{prefix}:store:{namespace}:{id}` → JSON string
 *   Index: `{prefix}:index:{namespace}`      → ZSET (score = timestamp)
 */
export class RedisStore implements IStorageEngine {
  constructor(
    private redis: Redis,
    private keyPrefix: string = "oqron",
  ) {}

  private getKey(namespace: string, id: string): string {
    return `${this.keyPrefix}:store:${namespace}:${id}`;
  }

  private getIndexKey(namespace: string): string {
    return `${this.keyPrefix}:index:${namespace}`;
  }

  async save<T>(namespace: string, id: string, data: T): Promise<void> {
    const key = this.getKey(namespace, id);
    const indexKey = this.getIndexKey(namespace);

    // Serialize entire object as a single JSON blob — no field-flattening
    const json = JSON.stringify(data, (_k, v) => {
      if (v instanceof Date) return { __type: "Date", __val: v.toISOString() };
      return v;
    });

    const ts =
      (data as any).createdAt instanceof Date
        ? (data as any).createdAt.getTime()
        : Date.now();

    const pipeline = this.redis.multi();
    pipeline.set(key, json);
    pipeline.zadd(indexKey, ts, id);
    await pipeline.exec();
  }

  async get<T>(namespace: string, id: string): Promise<T | null> {
    const key = this.getKey(namespace, id);
    const raw = await this.redis.get(key);
    if (!raw) return null;
    return this.deserialize(raw) as T;
  }

  async list<T>(
    namespace: string,
    filter?: Record<string, any>,
    opts?: ListOptions,
  ): Promise<T[]> {
    const indexKey = this.getIndexKey(namespace);

    // Use offset/limit for pagination — no more hard-cap at 100
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 500; // sensible default, not a hard cap
    const ids = await this.redis.zrevrange(
      indexKey,
      offset,
      offset + limit - 1,
    );

    if (ids.length === 0) return [];

    // Batch-fetch all records
    const pipeline = this.redis.multi();
    for (const id of ids) {
      pipeline.get(this.getKey(namespace, id));
    }
    const results = await pipeline.exec();

    let entities: T[] = [];
    if (results) {
      for (const [err, res] of results) {
        if (!err && res && typeof res === "string") {
          try {
            entities.push(this.deserialize(res) as T);
          } catch {
            // Skip corrupted records
          }
        }
      }
    }

    // Apply exact match filtering in memory
    if (filter) {
      entities = entities.filter((item: any) => {
        for (const [key, val] of Object.entries(filter)) {
          if (item[key] !== val) return false;
        }
        return true;
      });
    }

    return entities;
  }

  async count(
    namespace: string,
    _filter?: Record<string, any>,
  ): Promise<number> {
    const indexKey = this.getIndexKey(namespace);
    // If no filter, the ZSET cardinality gives us an exact count without scanning
    if (!_filter) return this.redis.zcard(indexKey);

    // With filter, we must scan — use list() with the filter applied
    const all = await this.list(namespace, _filter, { limit: 100_000 });
    return all.length;
  }

  async delete(namespace: string, id: string): Promise<void> {
    const key = this.getKey(namespace, id);
    const indexKey = this.getIndexKey(namespace);
    await this.redis.multi().del(key).zrem(indexKey, id).exec();
  }

  async prune(namespace: string, beforeMs: number): Promise<number> {
    const indexKey = this.getIndexKey(namespace);
    const oldIds = await this.redis.zrangebyscore(indexKey, "-inf", beforeMs);

    if (oldIds.length === 0) return 0;

    const pipeline = this.redis.multi();
    for (const id of oldIds) {
      pipeline.del(this.getKey(namespace, id));
    }
    pipeline.zremrangebyscore(indexKey, "-inf", beforeMs);
    await pipeline.exec();

    return oldIds.length;
  }

  /**
   * Type-aware JSON deserialization.
   * Restores Date objects from the `{ __type: "Date", __val: ... }` wrapper.
   */
  private deserialize(raw: string): any {
    return JSON.parse(raw, (_k, v) => {
      if (v && typeof v === "object" && v.__type === "Date" && v.__val) {
        return new Date(v.__val);
      }
      return v;
    });
  }
}
