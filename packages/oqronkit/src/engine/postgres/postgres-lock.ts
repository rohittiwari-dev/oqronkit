import type { ILockAdapter } from "../types/engine.js";

/**
 * PostgreSQL distributed lock adapter using advisory locks and a locks table.
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
   * Uses INSERT ... ON CONFLICT to atomically check and acquire.
   */
  async acquire(key: string, ownerId: string, ttlMs: number): Promise<boolean> {
    await this.ensureTable();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const now = new Date().toISOString();

    // Attempt to insert or take over an expired lock
    const result = await this.pool.query(
      `INSERT INTO ${this.tableName} (key, owner_id, expires_at)
       VALUES ($1, $2, $3::timestamptz)
       ON CONFLICT (key) DO UPDATE
       SET owner_id = $2, expires_at = $3::timestamptz
       WHERE ${this.tableName}.expires_at < $4::timestamptz
       RETURNING key`,
      [key, ownerId, expiresAt, now],
    );

    return result.rowCount > 0;
  }

  /**
   * Renews a lock only if the caller is the current owner.
   */
  async renew(key: string, ownerId: string, ttlMs: number): Promise<boolean> {
    await this.ensureTable();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();

    const result = await this.pool.query(
      `UPDATE ${this.tableName}
       SET expires_at = $1::timestamptz
       WHERE key = $2 AND owner_id = $3`,
      [expiresAt, key, ownerId],
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
   */
  async isOwner(key: string, ownerId: string): Promise<boolean> {
    await this.ensureTable();
    const now = new Date().toISOString();

    const result = await this.pool.query(
      `SELECT 1 FROM ${this.tableName}
       WHERE key = $1 AND owner_id = $2 AND expires_at > $3::timestamptz`,
      [key, ownerId, now],
    );

    return result.rows.length > 0;
  }

  /** Gracefully close the pool */
  async close(): Promise<void> {
    if (this.pool) await this.pool.end();
  }
}
