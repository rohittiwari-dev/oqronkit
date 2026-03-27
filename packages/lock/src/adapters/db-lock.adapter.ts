import type { ILockAdapter } from "@chronoforge/core";
import Database from "better-sqlite3";

type LockRow = { ownerId: string; expiresAt: string };

export class DbLockAdapter implements ILockAdapter {
  private readonly db: Database.Database;

  /**
   * @param dbOrPath - Either a `better-sqlite3` Database instance or a file path.
   *                   When sharing the same SQLite file as SqliteAdapter, pass the same path.
   */
  constructor(dbOrPath: Database.Database | string = "chrono.sqlite") {
    if (typeof dbOrPath === "string") {
      this.db = new Database(dbOrPath);
    } else {
      this.db = dbOrPath;
    }
  }

  async acquire(key: string, ownerId: string, ttlMs: number): Promise<boolean> {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();

    this.db
      .prepare(`
      INSERT INTO chrono_locks (resourceKey, ownerId, expiresAt)
      VALUES (?, ?, ?)
      ON CONFLICT(resourceKey) DO UPDATE SET
        ownerId   = CASE WHEN expiresAt < ? THEN excluded.ownerId   ELSE ownerId   END,
        expiresAt = CASE WHEN expiresAt < ? THEN excluded.expiresAt ELSE expiresAt END
    `)
      .run(key, ownerId, expiresAt, now, now);

    const row = this.db
      .prepare(`SELECT ownerId FROM chrono_locks WHERE resourceKey = ?`)
      .get(key) as { ownerId: string } | undefined;

    return row?.ownerId === ownerId;
  }

  async renew(key: string, ownerId: string, ttlMs: number): Promise<boolean> {
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const result = this.db
      .prepare(`
      UPDATE chrono_locks SET expiresAt = ?
      WHERE resourceKey = ? AND ownerId = ?
    `)
      .run(expiresAt, key, ownerId);
    return result.changes > 0;
  }

  async release(key: string, ownerId: string): Promise<void> {
    this.db
      .prepare(`DELETE FROM chrono_locks WHERE resourceKey = ? AND ownerId = ?`)
      .run(key, ownerId);
  }

  async isOwner(key: string, ownerId: string): Promise<boolean> {
    const row = this.db
      .prepare(
        `SELECT ownerId, expiresAt FROM chrono_locks WHERE resourceKey = ?`,
      )
      .get(key) as LockRow | undefined;

    if (!row) return false;
    const expired = new Date(row.expiresAt) < new Date();
    return !expired && row.ownerId === ownerId;
  }
}
