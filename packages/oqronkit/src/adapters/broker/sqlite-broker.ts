import Database from "better-sqlite3";
import type { IQueueAdapter } from "../../core/types/queue.types.js";

/**
 * SqliteBrokerAdapter — local-first IBrokerAdapter powered by better-sqlite3.
 * Responsible strictly for signaling and atomic ID-based coordination.
 */
export class SqliteBrokerAdapter implements IQueueAdapter {
  private readonly db: Database.Database;

  constructor(dbOrPath: Database.Database | string = "oqron.sqlite") {
    this.db = typeof dbOrPath === "string" ? new Database(dbOrPath) : dbOrPath;
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      -- Broker Signaling Table
      CREATE TABLE IF NOT EXISTS oqron_broker_waiting (
        queue_name TEXT NOT NULL,
        job_id     TEXT NOT NULL,
        run_at     INTEGER NOT NULL, -- Unix timestamp ms
        PRIMARY KEY (queue_name, job_id)
      );

      -- Active Locks
      CREATE TABLE IF NOT EXISTS oqron_broker_locks (
        job_id     TEXT PRIMARY KEY,
        worker_id  TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );

      -- Pause state
      CREATE TABLE IF NOT EXISTS oqron_broker_paused (
        queue_name TEXT PRIMARY KEY
      );

      CREATE INDEX IF NOT EXISTS idx_oqwaiting_runat ON oqron_broker_waiting(run_at);
    `);
  }

  async signalEnqueue(
    queueName: string,
    jobId: string,
    delayMs = 0,
  ): Promise<void> {
    const runAt = Date.now() + delayMs;
    this.db
      .prepare(
        `
      INSERT INTO oqron_broker_waiting (queue_name, job_id, run_at)
      VALUES (?, ?, ?)
      ON CONFLICT(queue_name, job_id) DO UPDATE SET run_at = excluded.run_at
    `,
      )
      .run(queueName, jobId, runAt);
  }

  async claimJobIds(
    queueName: string,
    workerId: string,
    limit: number,
    lockTtlMs: number,
  ): Promise<string[]> {
    const paused = this.db
      .prepare(`SELECT 1 FROM oqron_broker_paused WHERE queue_name = ?`)
      .get(queueName);
    if (paused) return [];

    const now = Date.now();
    const expiresAt = now + lockTtlMs;

    const claim = this.db.transaction(() => {
      // 1. Fetch due IDs
      const rows = this.db
        .prepare(
          `
        SELECT job_id FROM oqron_broker_waiting
        WHERE queue_name = ? AND run_at <= ?
        LIMIT ?
      `,
        )
        .all(queueName, now, limit) as { job_id: string }[];

      const claimedIds = rows.map((r) => r.job_id);

      for (const id of claimedIds) {
        // 2. Remove from waiting
        this.db
          .prepare(`DELETE FROM oqron_broker_waiting WHERE job_id = ?`)
          .run(id);
        // 3. Set lock
        this.db
          .prepare(
            `
          INSERT INTO oqron_broker_locks (job_id, worker_id, expires_at)
          VALUES (?, ?, ?)
        `,
          )
          .run(id, workerId, expiresAt);
      }

      return claimedIds;
    });

    return claim();
  }

  async extendLock(
    jobId: string,
    workerId: string,
    lockTtlMs: number,
  ): Promise<void> {
    const now = Date.now();
    const result = this.db
      .prepare(
        `
      UPDATE oqron_broker_locks
      SET expires_at = ?
      WHERE job_id = ? AND worker_id = ?
    `,
      )
      .run(now + lockTtlMs, jobId, workerId);

    if (result.changes === 0) throw new Error("Lock lost or stolen");
  }

  async ack(jobId: string): Promise<void> {
    this.db
      .prepare(`DELETE FROM oqron_broker_locks WHERE job_id = ?`)
      .run(jobId);
  }

  async setQueuePaused(queueName: string, paused: boolean): Promise<void> {
    if (paused) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO oqron_broker_paused (queue_name) VALUES (?)`,
        )
        .run(queueName);
    } else {
      this.db
        .prepare(`DELETE FROM oqron_broker_paused WHERE queue_name = ?`)
        .run(queueName);
    }
  }

  async ping(): Promise<boolean> {
    return true;
  }
}
