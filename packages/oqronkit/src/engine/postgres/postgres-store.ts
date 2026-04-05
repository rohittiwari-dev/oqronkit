import type { IStorageEngine, ListOptions } from "../types/engine.js";

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
  private initialized = false;

  constructor(connectionString: string, tablePrefix = "oqron", poolSize = 10) {
    this.tableName = `${tablePrefix}_store`;
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
      CREATE INDEX IF NOT EXISTS idx_${this.tableName}_data
      ON ${this.tableName} USING GIN (data)
    `);

    this.initialized = true;
  }

  async save<T>(namespace: string, id: string, data: T): Promise<void> {
    await this.ensureTable();
    const json = JSON.stringify(data, (_k, v) => {
      if (v instanceof Date) return { __type: "Date", __val: v.toISOString() };
      return v;
    });
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
    const limit = opts?.limit ?? 500;
    const offset = opts?.offset ?? 0;

    let query: string;
    const params: any[] = [namespace];

    if (filter && Object.keys(filter).length > 0) {
      // Build JSONB @> containment query for exact match filtering
      const filterJson = JSON.stringify(filter);
      query = `SELECT data FROM ${this.tableName}
               WHERE namespace = $1 AND data @> $2::jsonb
               ORDER BY created_at DESC
               LIMIT $3 OFFSET $4`;
      params.push(filterJson, limit, offset);
    } else {
      query = `SELECT data FROM ${this.tableName}
               WHERE namespace = $1
               ORDER BY created_at DESC
               LIMIT $2 OFFSET $3`;
      params.push(limit, offset);
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
      const filterJson = JSON.stringify(filter);
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
    const cutoff = new Date(beforeMs).toISOString();
    const result = await this.pool.query(
      `DELETE FROM ${this.tableName}
       WHERE namespace = $1 AND created_at < $2::timestamptz`,
      [namespace, cutoff],
    );
    return result.rowCount ?? 0;
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
}
