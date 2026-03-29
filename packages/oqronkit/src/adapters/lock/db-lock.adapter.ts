import type { ILockAdapter } from "../../core/index.js";

type LockRow = { ownerId: string; expiresAt: string };

export class DbLockAdapter implements ILockAdapter {
  private readonly db: any;
  private readonly defaultTtl: number;

  /**
   * @param dbOrPath - Either a `better-sqlite3` Database instance or a file path.
   *                   When sharing the same SQLite file as SqliteAdapter, pass the same path.
   * @param defaultTtlMs - Default TTL for locks if not provided in acquire (optional)
   */
  constructor(dbOrPath: any | string = "oqron.sqlite", defaultTtlMs = 30_000) {
    this.defaultTtl = defaultTtlMs;
    if (typeof dbOrPath === "string") {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const Database = require("better-sqlite3");
        this.db = new Database(dbOrPath);
      } catch {
        throw new Error(
          "[OqronKit] DbLockAdapter requires 'better-sqlite3'. Install it: npm install better-sqlite3",
        );
      }
    } else {
      this.db = dbOrPath;
    }
  }

  async acquire(
    key: string,
    ownerId: string,
    ttlMs?: number,
  ): Promise<boolean> {
    const finalTtl = ttlMs ?? this.defaultTtl;
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + finalTtl).toISOString();

    this.db
      .prepare(
        `
      INSERT INTO oqron_locks (resourceKey, ownerId, expiresAt)
      VALUES (?, ?, ?)
      ON CONFLICT(resourceKey) DO UPDATE SET
        ownerId   = CASE WHEN expiresAt < ? THEN excluded.ownerId   ELSE ownerId   END,
        expiresAt = CASE WHEN expiresAt < ? THEN excluded.expiresAt ELSE expiresAt END
    `,
      )
      .run(key, ownerId, expiresAt, now, now);

    const row = this.db
      .prepare(`SELECT ownerId FROM oqron_locks WHERE resourceKey = ?`)
      .get(key) as { ownerId: string } | undefined;

    return row?.ownerId === ownerId;
  }

  async renew(key: string, ownerId: string, ttlMs?: number): Promise<boolean> {
    const finalTtl = ttlMs ?? this.defaultTtl;
    const expiresAt = new Date(Date.now() + finalTtl).toISOString();
    const result = this.db
      .prepare(
        `
      UPDATE oqron_locks SET expiresAt = ?
      WHERE resourceKey = ? AND ownerId = ?
    `,
      )
      .run(expiresAt, key, ownerId);
    return result.changes > 0;
  }

  async release(key: string, ownerId: string): Promise<void> {
    this.db
      .prepare(`DELETE FROM oqron_locks WHERE resourceKey = ? AND ownerId = ?`)
      .run(key, ownerId);
  }

  async isOwner(key: string, ownerId: string): Promise<boolean> {
    const row = this.db
      .prepare(
        `SELECT ownerId, expiresAt FROM oqron_locks WHERE resourceKey = ?`,
      )
      .get(key) as LockRow | undefined;

    if (!row) return false;
    const expired = new Date(row.expiresAt) < new Date();
    return !expired && row.ownerId === ownerId;
  }
}
