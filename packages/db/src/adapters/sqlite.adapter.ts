import type {
  CronDefinition,
  IChronoAdapter,
  JobRecord,
} from "@chronoforge/core";
import Database from "better-sqlite3";

export class SqliteAdapter implements IChronoAdapter {
  private readonly db: Database.Database;

  /**
   * @param dbOrPath - Either a `better-sqlite3` Database instance (for testing with `:memory:`)
   *                   or a file path string. Defaults to `"chrono.sqlite"`.
   */
  constructor(dbOrPath: Database.Database | string = "chrono.sqlite") {
    if (typeof dbOrPath === "string") {
      this.db = new Database(dbOrPath);
    } else {
      this.db = dbOrPath;
    }
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  /** Create tables if they don't exist */
  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chrono_schedules (
        id              TEXT PRIMARY KEY,
        expression      TEXT NOT NULL,
        timezone        TEXT,
        missedFirePolicy TEXT NOT NULL DEFAULT 'skip',
        overlap         INTEGER NOT NULL DEFAULT 1,
        tags            TEXT NOT NULL DEFAULT '[]',
        lastRunAt       TEXT,
        nextRunAt       TEXT
      );

      CREATE TABLE IF NOT EXISTS chrono_jobs (
        id          TEXT PRIMARY KEY,
        scheduleId  TEXT,
        status      TEXT NOT NULL,
        startedAt   TEXT NOT NULL,
        completedAt TEXT,
        error       TEXT,
        FOREIGN KEY(scheduleId) REFERENCES chrono_schedules(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS chrono_locks (
        resourceKey TEXT PRIMARY KEY,
        ownerId     TEXT NOT NULL,
        expiresAt   TEXT NOT NULL
      );
    `);
  }

  async upsertSchedule(def: CronDefinition): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO chrono_schedules (id, expression, timezone, missedFirePolicy, overlap, tags)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           expression       = excluded.expression,
           timezone         = excluded.timezone,
           missedFirePolicy = excluded.missedFirePolicy,
           overlap          = excluded.overlap,
           tags             = excluded.tags`,
      )
      .run(
        def.name,
        def.expression ?? (def.intervalMs ? `every:${def.intervalMs}ms` : null),
        def.timezone ?? null,
        def.missedFire,
        def.overlap !== "skip" && def.overlap !== false ? 1 : 0,
        JSON.stringify(def.tags),
      );
  }

  async getDueSchedules(
    now: Date,
    limit: number,
  ): Promise<Pick<CronDefinition, "name">[]> {
    return this.db
      .prepare(
        `SELECT id as name FROM chrono_schedules
         WHERE nextRunAt IS NULL OR nextRunAt <= ?
         LIMIT ?`,
      )
      .all(now.toISOString(), limit) as { name: string }[];
  }

  async getSchedules(): Promise<
    Array<{ name: string; lastRunAt: Date | null; nextRunAt: Date | null }>
  > {
    const rows = this.db
      .prepare(`SELECT id, lastRunAt, nextRunAt FROM chrono_schedules`)
      .all() as Array<{
      id: string;
      lastRunAt: string | null;
      nextRunAt: string | null;
    }>;
    return rows.map((r) => ({
      name: r.id,
      lastRunAt: r.lastRunAt ? new Date(r.lastRunAt) : null,
      nextRunAt: r.nextRunAt ? new Date(r.nextRunAt) : null,
    }));
  }

  async updateNextRun(scheduleId: string, nextRunAt: Date): Promise<void> {
    this.db
      .prepare(`UPDATE chrono_schedules SET nextRunAt = ? WHERE id = ?`)
      .run(nextRunAt.toISOString(), scheduleId);
  }

  async recordExecution(job: JobRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO chrono_jobs (id, scheduleId, status, startedAt, completedAt, error)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status      = excluded.status,
           completedAt = excluded.completedAt,
           error       = excluded.error`,
      )
      .run(
        job.id,
        job.scheduleId ?? null,
        job.status,
        job.startedAt.toISOString(),
        job.completedAt?.toISOString() ?? null,
        job.error ?? null,
      );

    if (
      job.scheduleId &&
      (job.status === "completed" || job.status === "failed")
    ) {
      this.db
        .prepare(`UPDATE chrono_schedules SET lastRunAt = ? WHERE id = ?`)
        .run((job.completedAt ?? new Date()).toISOString(), job.scheduleId);
    }
  }

  async getExecutions(
    scheduleId: string,
    opts: { limit: number; offset: number },
  ): Promise<JobRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT id, scheduleId, status, startedAt, completedAt, error
         FROM chrono_jobs WHERE scheduleId = ?
         ORDER BY startedAt DESC
         LIMIT ? OFFSET ?`,
      )
      .all(scheduleId, opts.limit, opts.offset) as Array<{
      id: string;
      scheduleId: string | null;
      status: string;
      startedAt: string;
      completedAt: string | null;
      error: string | null;
    }>;

    return rows.map((r) => ({
      id: r.id,
      scheduleId: r.scheduleId ?? undefined,
      status: r.status as JobRecord["status"],
      startedAt: new Date(r.startedAt),
      completedAt: r.completedAt ? new Date(r.completedAt) : undefined,
      error: r.error ?? undefined,
    }));
  }

  async getActiveJobs(): Promise<JobRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT id, scheduleId, status, startedAt, completedAt, error
         FROM chrono_jobs WHERE status = 'running'`,
      )
      .all() as Array<{
      id: string;
      scheduleId: string | null;
      status: string;
      startedAt: string;
      completedAt: string | null;
      error: string | null;
    }>;

    return rows.map((r) => ({
      id: r.id,
      scheduleId: r.scheduleId ?? undefined,
      status: r.status as JobRecord["status"],
      startedAt: new Date(r.startedAt),
      completedAt: r.completedAt ? new Date(r.completedAt) : undefined,
      error: r.error ?? undefined,
    }));
  }

  async cleanOldExecutions(before: Date): Promise<number> {
    const result = this.db
      .prepare(`DELETE FROM chrono_jobs WHERE startedAt < ?`)
      .run(before.toISOString());
    return result.changes;
  }
}
