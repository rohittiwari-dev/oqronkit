import type { Redis } from "ioredis";
import type { IStorageEngine } from "../types/engine.js";

/**
 * Redis implementation of the universal Storage Engine.
 *
 * Persists and indexes all entities (Jobs, Webhooks, Schedules) using Hashes.
 *
 * Namespace keys: `oqron:store:{namespace}:{id}` -> Hash
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

    // Multi-transaction: save Hash data and add to ZSET index for sorting
    const pipeline = this.redis.multi();

    // Convert object to flat key/value array for HSET
    // e.g. { status: "active", data: { foo: 1 } }
    const flatData: Record<string, string> = {};
    for (const [k, v] of Object.entries(data as any)) {
      if (typeof v === "object" && v !== null) {
        // Date objects handling
        if (v instanceof Date) {
          flatData[k] = v.toISOString();
        } else {
          flatData[k] = JSON.stringify(v);
        }
      } else {
        flatData[k] = String(v);
      }
    }

    pipeline.hset(key, flatData);

    // Maintain a ZSET index sorted by timestamp (default Date.now())
    const ts =
      (data as any).createdAt instanceof Date
        ? (data as any).createdAt.getTime()
        : Date.now();

    pipeline.zadd(indexKey, ts, id);

    await pipeline.exec();
  }

  async get<T>(namespace: string, id: string): Promise<T | null> {
    const key = this.getKey(namespace, id);
    const result = await this.redis.hgetall(key);

    if (!result || Object.keys(result).length === 0) return null;

    // We must deserialize json strings and ISO dates back dynamically.
    // In strict production setups, the caller zod validates this.
    return this.deserialize(result) as T;
  }

  async list<T>(namespace: string, filter?: Record<string, any>): Promise<T[]> {
    const indexKey = this.getIndexKey(namespace);
    // Fetch top 100 most recent for now
    const ids = await this.redis.zrevrange(indexKey, 0, 99);

    if (ids.length === 0) return [];

    const pipeline = this.redis.multi();
    for (const id of ids) {
      pipeline.hgetall(this.getKey(namespace, id));
    }

    const results = await pipeline.exec();

    let entities: T[] = [];
    if (results) {
      for (const [err, res] of results) {
        if (!err && res && Object.keys(res).length > 0) {
          entities.push(this.deserialize(res as Record<string, any>) as T);
        }
      }
    }

    // Apply exact match filtering in local memory (Redis doesn't support generic Secondary Indexes natively)
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

  async delete(namespace: string, id: string): Promise<void> {
    const key = this.getKey(namespace, id);
    const indexKey = this.getIndexKey(namespace);
    await this.redis.multi().del(key).zrem(indexKey, id).exec();
  }

  async prune(namespace: string, beforeMs: number): Promise<number> {
    const indexKey = this.getIndexKey(namespace);
    // Find all IDs older than beforeMs
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

  private deserialize(record: Record<string, string>): any {
    const out: any = {};
    for (const [k, v] of Object.entries(record)) {
      try {
        // Simple heuristic for JSON vs String vs Date
        if (v.startsWith("{") || v.startsWith("[")) {
          out[k] = JSON.parse(v);
        } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)) {
          out[k] = new Date(v);
        } else if (v === "undefined") {
          out[k] = undefined; // Rare but possible
        } else {
          // Could be boolean or number, leave as string if ambiguous
          if (v === "true") out[k] = true;
          else if (v === "false") out[k] = false;
          else if (!Number.isNaN(Number(v)) && v.trim() !== "")
            out[k] = Number(v);
          else out[k] = v;
        }
      } catch {
        out[k] = v; // Fallback to raw string
      }
    }
    // Specific fixes for OqronJob types if they slip through string checks
    if (out.attemptMade !== undefined)
      out.attemptMade = Number(out.attemptMade);
    if (out.progressPercent !== undefined)
      out.progressPercent = Number(out.progressPercent);
    return out;
  }
}
