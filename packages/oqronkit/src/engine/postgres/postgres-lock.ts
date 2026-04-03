import type { ILockAdapter } from "../types/engine.js";

/**
 * PostgreSQL distributed lock adapter using advisory locks and a locks table.
 *
 * **Clock-Safety:** All time comparisons use server-side `NOW()` to prevent
 * clock-skew vulnerabilities in multi-node deployments. Never uses client-side
 * `Date.now()` for lock expiry logic.
 *
 * Table (auto-created):
 *   {prefix}_locks (
 *     key       TEXT PRIMARY KEY,
 *     owner_id  TEXT NOT NULL,
 *     expires_at TIMESTAMPTZ NOT NULL
 *   )
 */
export class PostgresLock implements ILockAdapter {
  private pool: any;
  private tableName: string;
  private initialized = false;

  constructor(connectionString: string, tablePrefix = "oqron", poolSize = 10) {
    this.tableName = `${tablePrefix}_locks`;
    this._initPool(connectionString, poolSize);
  }

  private async _initPool(
    connectionString: string,
    poolSize: number,
  ): Promise<void> {
    const { Pool } = await import("pg");
    this.pool = new Pool({ connectionString, max: poolSize });
  }

  private async ensureTable(): Promise<void> {
    if (this.initialized) return;
    while (!this.pool) await new Promise((r) => setTimeout(r, 10));

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        key TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      )
    `);

    this.initialized = true;
  }

  /**
   * Attempts to acquire a lock. Returns true if acquired, false if already held.
   * Uses INSERT ... ON CONFLICT with server-side NOW() to atomically check and acquire.
   *
   * Clock-safe: all time comparisons happen on the PostgreSQL server.
   */
  async acquire(key: string, ownerId: string, ttlMs: number): Promise<boolean> {
    await this.ensureTable();

    // Use server-side NOW() for both the new expiry and the "is expired?" check.
    // $3 is the TTL in milliseconds — converted to an interval server-side.
    const result = await this.pool.query(
      `INSERT INTO ${this.tableName} (key, owner_id, expires_at)
       VALUES ($1, $2, NOW() + ($3 || ' milliseconds')::interval)
       ON CONFLICT (key) DO UPDATE
       SET owner_id = $2, expires_at = NOW() + ($3 || ' milliseconds')::interval
       WHERE ${this.tableName}.expires_at < NOW()
          OR ${this.tableName}.owner_id = $2
       RETURNING key`,
      [key, ownerId, ttlMs],
    );

    return result.rowCount > 0;
  }

  /**
   * Renews a lock only if the caller is the current owner.
   * Clock-safe: expiry computed on the PostgreSQL server.
   */
  async renew(key: string, ownerId: string, ttlMs: number): Promise<boolean> {
    await this.ensureTable();

    const result = await this.pool.query(
      `UPDATE ${this.tableName}
       SET expires_at = NOW() + ($1 || ' milliseconds')::interval
       WHERE key = $2 AND owner_id = $3`,
      [ttlMs, key, ownerId],
    );

    return result.rowCount > 0;
  }

  /**
   * Releases a lock only if the caller is the current owner.
   */
  async release(key: string, ownerId: string): Promise<void> {
    await this.ensureTable();
    await this.pool.query(
      `DELETE FROM ${this.tableName} WHERE key = $1 AND owner_id = $2`,
      [key, ownerId],
    );
  }

  /**
   * Checks if a specific owner holds the lock (and it hasn't expired).
   * Clock-safe: expiry check uses server-side NOW().
   */
  async isOwner(key: string, ownerId: string): Promise<boolean> {
    await this.ensureTable();

    const result = await this.pool.query(
      `SELECT 1 FROM ${this.tableName}
       WHERE key = $1 AND owner_id = $2 AND expires_at > NOW()`,
      [key, ownerId],
    );

    return result.rows.length > 0;
  }

  /** Gracefully close the pool */
  async close(): Promise<void> {
    if (this.pool) await this.pool.end();
  }
}

