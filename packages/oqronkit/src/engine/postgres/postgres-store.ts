import type { IStorageEngine, ListOptions } from "../types/engine.js";
import { assertValidIdentifier, quoteIdentifier } from "./identifiers.js";

/**
 * PostgreSQL implementation of the universal Storage Engine.
 *
 * Uses a single JSONB column for data with GIN indexing for filter queries.
 * Requires `pg` as a peer dependency.
 *
 * Table schema (auto-created on init):
 *   {prefix}_store (
 *     namespace TEXT NOT NULL,
 *     id        TEXT NOT NULL,
 *     data      JSONB NOT NULL,
 *     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *     PRIMARY KEY (namespace, id)
 *   )
 */
export class PostgresStore implements IStorageEngine {
  private pool: any; // pg.Pool
  private tableName: string;
  private dataIndexName: string;
  private initialized = false;

  constructor(connectionString: string, tablePrefix = "oqron", poolSize = 10) {
    const safePrefix = assertValidIdentifier(tablePrefix, "tablePrefix");
    this.tableName = quoteIdentifier(
      `${safePrefix}_store`,
      "storage table name",
    );
    this.dataIndexName = quoteIdentifier(
      `idx_${safePrefix}_store_data`,
      "storage index name",
    );
    // Lazy import to keep `pg` as an optional peer dependency
    this._initPool(connectionString, poolSize);
  }

  private async _initPool(
    connectionString: string,
    poolSize: number,
  ): Promise<void> {
    const { Pool } = await import("pg");
    this.pool = new Pool({
      connectionString,
      max: poolSize,
    });
  }

  /** Ensures the storage table exists. Called lazily on first operation. */
  private async ensureTable(): Promise<void> {
    if (this.initialized) return;
    // Wait for pool to be created
    while (!this.pool) await new Promise((r) => setTimeout(r, 10));

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        namespace TEXT NOT NULL,
        id TEXT NOT NULL,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (namespace, id)
      )
    `);

    // GIN index for JSONB filter queries
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${this.dataIndexName}
      ON ${this.tableName} USING GIN (data)
    `);

    this.initialized = true;
  }

  async save<T>(namespace: string, id: string, data: T): Promise<void> {
    await this.ensureTable();
    const json = JSON.stringify(this.encodeDates(data));
    await this.pool.query(
      `INSERT INTO ${this.tableName} (namespace, id, data, created_at)
       VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (namespace, id)
       DO UPDATE SET data = $3::jsonb`,
      [namespace, id, json],
    );
  }

  async get<T>(namespace: string, id: string): Promise<T | null> {
    await this.ensureTable();
    const result = await this.pool.query(
      `SELECT data FROM ${this.tableName} WHERE namespace = $1 AND id = $2`,
      [namespace, id],
    );
    if (result.rows.length === 0) return null;
    return this.deserialize(result.rows[0].data);
  }

  async list<T>(
    namespace: string,
    filter?: Record<string, any>,
    opts?: ListOptions,
  ): Promise<T[]> {
    await this.ensureTable();
    const limit = opts?.limit;
    const offset = opts?.offset ?? 0;

    let query: string;
    const params: any[] = [namespace];

    if (filter && Object.keys(filter).length > 0) {
      // Build JSONB @> containment query for exact match filtering
      const filterJson = JSON.stringify(this.encodeDates(filter));
      query = `SELECT data FROM ${this.tableName}
               WHERE namespace = $1 AND data @> $2::jsonb`;
      params.push(filterJson);
    } else {
      query = `SELECT data FROM ${this.tableName}
               WHERE namespace = $1`;
    }

    //  Append WHERE conditions for comparison operators
    if (opts?.where) {
      for (const cond of opts.where) {
        const sqlOp = { $lt: "<", $lte: "<=", $gt: ">", $gte: ">=", $ne: "!=" }[
          cond.op
        ];
        const fieldIdx = params.length + 1;
        params.push(cond.field);
        const valueIdx = params.length + 1;

        if (cond.value instanceof Date) {
          // Date values stored as { __type: "Date", __val: "ISO" } wrapper
          query += ` AND (data -> ($${fieldIdx})::text ->> '__val')::timestamptz ${sqlOp} $${valueIdx}::timestamptz`;
          params.push(cond.value.toISOString());
        } else if (
          typeof cond.value === "number" &&
          Number.isFinite(cond.value)
        ) {
          query += ` AND (data ->> ($${fieldIdx})::text)::numeric ${sqlOp} $${valueIdx}::numeric`;
          params.push(cond.value);
        } else {
          query += ` AND (data ->> ($${fieldIdx})::text)::text ${sqlOp} $${valueIdx}::text`;
          params.push(String(cond.value));
        }
      }
    }

    query += ` ORDER BY created_at DESC`;
    if (limit !== undefined) {
      const limitIdx = params.length + 1;
      query += ` LIMIT $${limitIdx}`;
      params.push(limit);
    }
    if (offset > 0) {
      const offsetIdx = params.length + 1;
      query += ` OFFSET $${offsetIdx}`;
      params.push(offset);
    }

    const result = await this.pool.query(query, params);
    return result.rows.map((row: any) => this.deserialize(row.data));
  }

  async count(
    namespace: string,
    filter?: Record<string, any>,
  ): Promise<number> {
    await this.ensureTable();

    if (filter && Object.keys(filter).length > 0) {
      const filterJson = JSON.stringify(this.encodeDates(filter));
      const result = await this.pool.query(
        `SELECT COUNT(*) AS cnt FROM ${this.tableName}
         WHERE namespace = $1 AND data @> $2::jsonb`,
        [namespace, filterJson],
      );
      return parseInt(result.rows[0].cnt, 10);
    }

    const result = await this.pool.query(
      `SELECT COUNT(*) AS cnt FROM ${this.tableName} WHERE namespace = $1`,
      [namespace],
    );
    return parseInt(result.rows[0].cnt, 10);
  }

  async delete(namespace: string, id: string): Promise<void> {
    await this.ensureTable();
    await this.pool.query(
      `DELETE FROM ${this.tableName} WHERE namespace = $1 AND id = $2`,
      [namespace, id],
    );
  }

  async prune(namespace: string, beforeMs: number): Promise<number> {
    await this.ensureTable();
    const result = await this.pool.query(
      `SELECT id, data, created_at FROM ${this.tableName}
       WHERE namespace = $1`,
      [namespace],
    );

    let pruned = 0;
    for (const row of result.rows) {
      const record = this.deserialize(row.data);
      const recordTime =
        this.toEpochMs(record?.createdAt) ??
        this.toEpochMs(record?.expiresAt) ??
        this.toEpochMs(row.created_at);
      if (recordTime !== undefined && recordTime < beforeMs) {
        await this.delete(namespace, row.id);
        pruned++;
      }
    }

    return pruned;
  }

  /** Gracefully close the connection pool */
  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
    }
  }

  private deserialize(data: any): any {
    if (typeof data === "string") {
      return JSON.parse(data, (_k, v) => {
        if (v && typeof v === "object" && v.__type === "Date" && v.__val) {
          return new Date(v.__val);
        }
        return v;
      });
    }
    // PostgreSQL JSONB is already parsed — just revive Dates
    return this.reviveDates(data);
  }

  private reviveDates(obj: any): any {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === "object" && obj.__type === "Date" && obj.__val) {
      return new Date(obj.__val);
    }
    if (Array.isArray(obj)) return obj.map((v) => this.reviveDates(v));
    if (typeof obj === "object") {
      for (const key of Object.keys(obj)) {
        obj[key] = this.reviveDates(obj[key]);
      }
    }
    return obj;
  }

  private encodeDates(value: any): any {
    if (value instanceof Date) {
      return { __type: "Date", __val: value.toISOString() };
    }
    if (Array.isArray(value)) return value.map((v) => this.encodeDates(v));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        out[key] = this.encodeDates(val);
      }
      return out;
    }
    return value;
  }

  private toEpochMs(value: unknown): number | undefined {
    if (value instanceof Date) return value.getTime();
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = new Date(value).getTime();
      return Number.isNaN(parsed) ? undefined : parsed;
    }
    if (
      value &&
      typeof value === "object" &&
      (value as any).__type === "Date" &&
      typeof (value as any).__val === "string"
    ) {
      const parsed = new Date((value as any).__val).getTime();
      return Number.isNaN(parsed) ? undefined : parsed;
    }
    return undefined;
  }
}
