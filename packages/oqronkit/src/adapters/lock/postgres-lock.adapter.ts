import type { ILockAdapter } from "../../core/index.js";

/**
 * PostgresLockAdapter — Production-grade distributed lock adapter using PostgreSQL.
 *
 * Uses `INSERT ... ON CONFLICT` with expiration-based preemption for lock acquisition,
 * matching the same semantics as `DbLockAdapter` (SQLite) but running against a
 * shared PostgreSQL instance for horizontal scaling.
 *
 * Requires the `oqron_locks` table (auto-created by `PostgresAdapter.migrate()`).
 *
 * Usage:
 * ```ts
 * import { Pool } from "pg";
 * import { PostgresLockAdapter } from "oqronkit";
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const lock = new PostgresLockAdapter(pool);
 * ```
 */
export class PostgresLockAdapter implements ILockAdapter {
  constructor(
    private readonly pool: {
      query(
        text: string,
        values?: unknown[],
      ): Promise<{ rows: any[]; rowCount: number | null }>;
    },
    private readonly defaultTtlMs: number = 30_000,
  ) {}

  async acquire(
    key: string,
    ownerId: string,
    ttlMs?: number,
  ): Promise<boolean> {
    const finalTtl = ttlMs ?? this.defaultTtlMs;
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + finalTtl).toISOString();

    // Atomic upsert: only take over if the existing lock is expired
    await this.pool.query(
      `INSERT INTO oqron_locks ("resourceKey", "ownerId", "expiresAt")
       VALUES ($1, $2, $3)
       ON CONFLICT ("resourceKey") DO UPDATE SET
         "ownerId"   = CASE WHEN oqron_locks."expiresAt" < $4 THEN $2 ELSE oqron_locks."ownerId" END,
         "expiresAt"  = CASE WHEN oqron_locks."expiresAt" < $4 THEN $3 ELSE oqron_locks."expiresAt" END`,
      [key, ownerId, expiresAt, now],
    );

    // Verify we actually own it
    const result = await this.pool.query(
      `SELECT "ownerId" FROM oqron_locks WHERE "resourceKey" = $1`,
      [key],
    );

    return result.rows[0]?.ownerId === ownerId;
  }

  async renew(key: string, ownerId: string, ttlMs?: number): Promise<boolean> {
    const finalTtl = ttlMs ?? this.defaultTtlMs;
    const expiresAt = new Date(Date.now() + finalTtl).toISOString();

    const result = await this.pool.query(
      `UPDATE oqron_locks SET "expiresAt" = $1
       WHERE "resourceKey" = $2 AND "ownerId" = $3`,
      [expiresAt, key, ownerId],
    );

    return (result.rowCount ?? 0) > 0;
  }

  async release(key: string, ownerId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM oqron_locks WHERE "resourceKey" = $1 AND "ownerId" = $2`,
      [key, ownerId],
    );
  }

  async isOwner(key: string, ownerId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT "ownerId", "expiresAt" FROM oqron_locks WHERE "resourceKey" = $1`,
      [key],
    );

    if (result.rows.length === 0) return false;
    const row = result.rows[0];
    const expired = new Date(row.expiresAt) < new Date();
    return !expired && row.ownerId === ownerId;
  }
}
