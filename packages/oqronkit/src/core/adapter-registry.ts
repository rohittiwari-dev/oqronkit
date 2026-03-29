import { SqliteBrokerAdapter } from "../adapters/broker/sqlite-broker.js";
import { SqliteAdapter } from "../adapters/db/sqlite.adapter.js";
import { DbLockAdapter } from "../adapters/lock/db-lock.adapter.js";
import { MemoryLockAdapter } from "../adapters/lock/memory-lock.adapter.js";
import { RedisLockAdapter } from "../adapters/lock/redis-lock.adapter.js";
import { MemoryAdapter } from "../adapters/memory.adapter.js";
import { RedisAdapter } from "../adapters/redis.adapter.js";
import type { OqronConfig } from "./types/config.types.js";
import type { IOqronAdapter } from "./types/db.types.js";
import type { ILockAdapter } from "./types/lock.types.js";
import type { IQueueAdapter } from "./types/queue.types.js";

/**
 * Central AdapterRegistry
 * Intelligently derives storage, lock, and broker based solely on `db` and `redis`.
 */
export class AdapterRegistry {
  private static instance: AdapterRegistry | null = null;

  private _db: IOqronAdapter | null = null;
  private _lock: ILockAdapter | null = null;
  private _broker: IQueueAdapter | null = null;

  private constructor(private readonly config: OqronConfig) {}

  static from(config: OqronConfig): AdapterRegistry {
    if (!AdapterRegistry.instance) {
      AdapterRegistry.instance = new AdapterRegistry(config);
    }
    return AdapterRegistry.instance;
  }

  static reset(): void {
    AdapterRegistry.instance = null;
  }

  // ── Database (IOqronAdapter) ───────────────────────────────────────────────

  resolveDb(): IOqronAdapter {
    if (this._db) return this._db;

    const { db, redis } = this.config;

    // 1. Explicit direct driver fallback (escape hatch)
    if (db && typeof (db as any).upsertJob === "function") {
      this._db = db as IOqronAdapter;
      return this._db;
    }

    // 2. Declarative Config object
    if (db && typeof db === "object" && "adapter" in db) {
      if (db.adapter === "sqlite") {
        this._db = new SqliteAdapter(db.url ?? "oqron.sqlite") as any;
        return this._db!;
      }
      // Note: Add postgres/mysql here later
    }

    // 3. Fallback to Redis if provided and no specific DB
    if (redis) {
      // If redis is passed as raw ioredis
      if (typeof redis === "object" && "set" in (redis as any)) {
        this._db = new RedisAdapter(redis as any) as any;
        return this._db!;
      }
      if (typeof redis === "object" && "url" in redis) {
        // Will need ioredis, but assume they pass the instance for now until we dynamically import
      }
    }

    // 4. Memory Fallback
    const mem = new MemoryAdapter();
    this._db = mem as any;
    if (!this._broker) this._broker = mem;
    return this._db!;
  }

  // ── Lock (ILockAdapter) ────────────────────────────────────────────────────

  resolveLock(): ILockAdapter {
    if (this._lock) return this._lock;

    const { redis, db } = this.config;

    // Fast-path: Redis
    if (redis) {
      if (typeof redis === "object" && "set" in (redis as any)) {
        this._lock = new RedisLockAdapter(redis as any);
        return this._lock;
      }
    }

    // Fallback: DB Lock
    if (db && typeof db === "object" && db.adapter === "sqlite") {
      this._lock = new DbLockAdapter(this.resolveDb() as any);
      return this._lock;
    }

    // Fallback: Memory
    if (this._db instanceof MemoryAdapter) {
      // Memory adapter could implement locks but for now use specialized memory lock
    }
    this._lock = new MemoryLockAdapter();
    return this._lock;
  }

  // ── Broker (IQueueAdapter) ─────────────────────────────────────────────────

  resolveBroker(): IQueueAdapter {
    if (this._broker) return this._broker;

    const { redis, db } = this.config;

    // Fast path: Redis
    if (redis) {
      if (typeof redis === "object" && "set" in (redis as any)) {
        this._broker = new RedisAdapter(redis as any) as any;
        return this._broker!;
      }
      // Or they provided a broker explicitly via DI
    }

    // Fallback path: Shared SQL DB
    if (db && typeof db === "object" && db.adapter === "sqlite") {
      this._broker = new SqliteBrokerAdapter(db.url ?? "oqron.sqlite") as any;
      return this._broker!;
    }

    // Fallback: Memory
    if (this._db instanceof MemoryAdapter) {
      this._broker = this._db;
    } else {
      this._broker = new MemoryAdapter();
    }

    return this._broker;
  }
}
