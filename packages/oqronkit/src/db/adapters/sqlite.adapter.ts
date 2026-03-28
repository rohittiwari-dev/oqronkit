import Database from "better-sqlite3";
import type {
  CronDefinition,
  IOqronAdapter,
  JobRecord,
  ScheduleDefinition,
} from "../../core/index.js";

export class SqliteAdapter implements IOqronAdapter {
  private readonly db: Database.Database;

  /**
   * @param dbOrPath - Either a `better-sqlite3` Database instance (for testing with `:memory:`)
   *                   or a file path string. Defaults to `"oqron.sqlite"`.
   */
  constructor(dbOrPath: Database.Database | string = "oqron.sqlite") {
    if (typeof dbOrPath === "string") {
      this.db = new Database(dbOrPath);
    } else {
      this.db = dbOrPath;
    }
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("chrono = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  /** Create tables if they don't exist */
  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS oqron_schedules (
        id              TEXT PRIMARY KEY,
        expression      TEXT, -- Can be null now since rrule/runAt are supported
        timezone        TEXT,
        missedFirePolicy TEXT NOT NULL DEFAULT 'skip',
        overlap         INTEGER NOT NULL DEFAULT 1,
        tags            TEXT NOT NULL DEFAULT '[]',
        status          TEXT NOT NULL DEFAULT 'active',
        
        -- Advanced Scheduling Columns
        runAt           TEXT,
        runAfterOpts    TEXT,
        rrule           TEXT,
        recurring       TEXT,
        
        lastRunAt       TEXT,
        nextRunAt       TEXT
      );

      CREATE TABLE IF NOT EXISTS oqron_jobs (
        id          TEXT PRIMARY KEY,
        scheduleId  TEXT,
        status      TEXT NOT NULL,
        startedAt   TEXT NOT NULL,
        completedAt TEXT,
        error       TEXT,
        result      TEXT,
        progressPercent INTEGER,
        progressLabel TEXT,
        attempts    INTEGER DEFAULT 1,
        tags        TEXT,
        FOREIGN KEY(scheduleId) REFERENCES oqron_schedules(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS oqron_locks (
        resourceKey TEXT PRIMARY KEY,
        ownerId     TEXT NOT NULL,
        expiresAt   TEXT NOT NULL
      );
    `);

    // Safe optimistic migrations for existing databases
    const alters = [
      "ALTER TABLE oqron_schedules ADD COLUMN runAt TEXT",
      "ALTER TABLE oqron_schedules ADD COLUMN runAfterOpts TEXT",
      "ALTER TABLE oqron_schedules ADD COLUMN rrule TEXT",
      "ALTER TABLE oqron_schedules ADD COLUMN recurring TEXT",
      "ALTER TABLE oqron_schedules ADD COLUMN status TEXT DEFAULT 'active'",
      "ALTER TABLE oqron_jobs ADD COLUMN result TEXT",
      "ALTER TABLE oqron_jobs ADD COLUMN progressPercent INTEGER",
      "ALTER TABLE oqron_jobs ADD COLUMN progressLabel TEXT",
      "ALTER TABLE oqron_jobs ADD COLUMN attempts INTEGER",
      "ALTER TABLE oqron_jobs ADD COLUMN durationMs INTEGER",
      "ALTER TABLE oqron_jobs ADD COLUMN tags TEXT",
    ];
    for (const sql of alters) {
      try {
        this.db.exec(sql);
      } catch (_e) {
        // Ignored. SQLite throws if column already exists
      }
    }
  }

  async upsertSchedule(
    def: CronDefinition | ScheduleDefinition,
  ): Promise<void> {
    const isSchedule =
      "runAt" in def ||
      "rrule" in def ||
      "recurring" in def ||
      "runAfter" in def;

    this.db
      .prepare(
        `INSERT INTO oqron_schedules (
           id, expression, timezone, missedFirePolicy, overlap, tags,
           runAt, runAfterOpts, rrule, recurring, status
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           expression       = excluded.expression,
           timezone         = excluded.timezone,
           missedFirePolicy = excluded.missedFirePolicy,
           overlap          = excluded.overlap,
           tags             = excluded.tags,
           runAt            = excluded.runAt,
           runAfterOpts     = excluded.runAfterOpts,
           rrule            = excluded.rrule,
           recurring        = excluded.recurring`,
      )
      .run(
        def.name,
        "expression" in def
          ? (def.expression ??
              (def.intervalMs ? `every:${def.intervalMs}ms` : null))
          : "every" in def && def.every
            ? JSON.stringify(def.every)
            : null,
        def.timezone ?? null,
        def.missedFire,
        def.overlap !== "skip" && def.overlap !== false ? 1 : 0,
        JSON.stringify(def.tags),
        isSchedule && def.runAt ? def.runAt.toISOString() : null,
        isSchedule && def.runAfter ? JSON.stringify(def.runAfter) : null,
        isSchedule && def.rrule ? def.rrule : null,
        isSchedule && def.recurring ? JSON.stringify(def.recurring) : null,
        def.status ?? "active",
      );
  }

  async getDueSchedules(
    now: Date,
    limit: number,
    prefix?: string,
  ): Promise<Pick<CronDefinition, "name">[]> {
    let sql = `SELECT id as name FROM oqron_schedules WHERE nextRunAt <= ? AND status = 'active'`;
    const params: any[] = [now.toISOString()];

    if (prefix) {
      sql += ` AND id LIKE ?`;
      params.push(`${prefix}%`);
    }

    sql += ` LIMIT ?`;
    params.push(limit);

    return this.db.prepare(sql).all(...params) as { name: string }[];
  }

  async getSchedules(
    prefix?: string,
  ): Promise<
    Array<{ name: string; lastRunAt: Date | null; nextRunAt: Date | null }>
  > {
    let sql = `SELECT id, lastRunAt, nextRunAt FROM oqron_schedules`;
    const params: any[] = [];

    if (prefix) {
      sql += ` WHERE id LIKE ?`;
      params.push(`${prefix}%`);
    }

    const rows = this.db.prepare(sql).all(...params) as Array<{
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

  async updateNextRun(
    scheduleId: string,
    nextRunAt: Date | null,
  ): Promise<void> {
    this.db
      .prepare(`UPDATE oqron_schedules SET nextRunAt = ? WHERE id = ?`)
      .run(nextRunAt ? nextRunAt.toISOString() : null, scheduleId);
  }

  async updateJobProgress(
    id: string,
    progressPercent: number,
    progressLabel?: string,
  ): Promise<void> {
    this.db
      .prepare(
        `UPDATE oqron_jobs SET progressPercent = ?, progressLabel = ? WHERE id = ?`,
      )
      .run(progressPercent, progressLabel ?? null, id);
  }

  async recordExecution(job: JobRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO oqron_jobs (id, scheduleId, status, startedAt, completedAt, error, result, attempts, progressPercent, progressLabel, durationMs)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status          = excluded.status,
           completedAt     = excluded.completedAt,
           error           = excluded.error,
           result          = excluded.result,
           attempts        = excluded.attempts,
           progressPercent = coalesce(excluded.progressPercent, progressPercent),
           progressLabel   = coalesce(excluded.progressLabel, progressLabel),
           durationMs      = excluded.durationMs`,
      )
      .run(
        job.id,
        job.scheduleId ?? null,
        job.status,
        job.startedAt.toISOString(),
        job.completedAt?.toISOString() ?? null,
        job.error ?? null,
        job.result ?? null,
        job.attempts ?? 1,
        job.progressPercent ?? null,
        job.progressLabel ?? null,
        job.durationMs ?? null,
      );

    if (
      job.scheduleId &&
      (job.status === "completed" || job.status === "failed")
    ) {
      this.db
        .prepare(`UPDATE oqron_schedules SET lastRunAt = ? WHERE id = ?`)
        .run((job.completedAt ?? new Date()).toISOString(), job.scheduleId);
    }
  }

  async getExecutions(
    scheduleId: string,
    opts: { limit: number; offset: number },
  ): Promise<JobRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT id, scheduleId, status, startedAt, completedAt, error, result, progressPercent, progressLabel, attempts, durationMs
         FROM oqron_jobs WHERE scheduleId = ?
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
      result: string | null;
      progressPercent: number | null;
      progressLabel: string | null;
      attempts: number | null;
      durationMs: number | null;
    }>;

    return rows.map((r) => ({
      id: r.id,
      scheduleId: r.scheduleId ?? undefined,
      status: r.status as JobRecord["status"],
      startedAt: new Date(r.startedAt),
      completedAt: r.completedAt ? new Date(r.completedAt) : undefined,
      error: r.error ?? undefined,
      result: r.result ?? undefined,
      progressPercent: r.progressPercent ?? undefined,
      progressLabel: r.progressLabel ?? undefined,
      attempts: r.attempts ?? undefined,
      durationMs: r.durationMs ?? undefined,
    }));
  }

  async getActiveJobs(): Promise<JobRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT id, scheduleId, status, startedAt, completedAt, error, result, progressPercent, progressLabel, attempts, durationMs
         FROM oqron_jobs WHERE status = 'running'`,
      )
      .all() as Array<{
      id: string;
      scheduleId: string | null;
      status: string;
      startedAt: string;
      completedAt: string | null;
      error: string | null;
      result: string | null;
      progressPercent: number | null;
      progressLabel: string | null;
      attempts: number | null;
      durationMs: number | null;
    }>;

    return rows.map((r) => ({
      id: r.id,
      scheduleId: r.scheduleId ?? undefined,
      status: r.status as JobRecord["status"],
      startedAt: new Date(r.startedAt),
      completedAt: r.completedAt ? new Date(r.completedAt) : undefined,
      error: r.error ?? undefined,
      result: r.result ?? undefined,
      progressPercent: r.progressPercent ?? undefined,
      progressLabel: r.progressLabel ?? undefined,
      attempts: r.attempts ?? undefined,
      durationMs: r.durationMs ?? undefined,
    }));
  }

  async cleanOldExecutions(before: Date): Promise<number> {
    const result = this.db
      .prepare(`DELETE FROM oqron_jobs WHERE startedAt < ?`)
      .run(before.toISOString());
    return result.changes;
  }

  async pruneHistoryForSchedule(
    scheduleId: string,
    keepJobHistory: number | boolean,
    keepFailedJobHistory: number | boolean,
  ): Promise<void> {
    if (keepJobHistory === false && keepFailedJobHistory === false) return;

    if (typeof keepJobHistory === "number") {
      this.db
        .prepare(
          `
        DELETE FROM oqron_jobs 
        WHERE scheduleId = ? AND status = 'completed'
        AND id NOT IN (
          SELECT id FROM oqron_jobs 
          WHERE scheduleId = ? AND status = 'completed' 
          ORDER BY startedAt DESC LIMIT ?
        )
      `,
        )
        .run(scheduleId, scheduleId, keepJobHistory);
    }

    if (typeof keepFailedJobHistory === "number") {
      this.db
        .prepare(
          `
        DELETE FROM oqron_jobs 
        WHERE scheduleId = ? AND status IN ('failed', 'dead')
        AND id NOT IN (
          SELECT id FROM oqron_jobs 
          WHERE scheduleId = ? AND status IN ('failed', 'dead') 
          ORDER BY startedAt DESC LIMIT ?
        )
      `,
        )
        .run(scheduleId, scheduleId, keepFailedJobHistory);
    }
  }

  async pauseSchedule(id: string): Promise<void> {
    this.db
      .prepare(`UPDATE oqron_schedules SET status = 'paused' WHERE id = ?`)
      .run(id);
  }

  async resumeSchedule(id: string): Promise<void> {
    this.db
      .prepare(`UPDATE oqron_schedules SET status = 'active' WHERE id = ?`)
      .run(id);
  }
}
