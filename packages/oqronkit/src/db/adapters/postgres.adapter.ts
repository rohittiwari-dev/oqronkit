import type {
  CronDefinition,
  IOqronAdapter,
  JobRecord,
  ScheduleDefinition,
} from "../../core/index.js";

/**
 * PostgresAdapter — Production-grade IOqronAdapter backed by PostgreSQL.
 *
 * Features:
 * - Connection pooling via `pg.Pool`
 * - Row-level locking with `FOR UPDATE SKIP LOCKED` to prevent
 *   duplicate job execution across 50+ horizontal containers
 * - Auto-migration on construction
 *
 * Usage:
 * ```ts
 * import { Pool } from "pg";
 * import { PostgresAdapter } from "oqronkit";
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const adapter = new PostgresAdapter(pool);
 * ```
 *
 * NOTE: `pg` is a peer dependency. Install it yourself:
 *   npm install pg @types/pg
 */
export class PostgresAdapter implements IOqronAdapter {
  /**
   * @param pool - A `pg.Pool` instance. We use the duck-typed interface
   *               so consumers can pass any pg-compatible pool.
   */
  constructor(
    private readonly pool: {
      query(
        text: string,
        values?: unknown[],
      ): Promise<{ rows: any[]; rowCount: number | null }>;
    },
  ) {}

  // ── Auto-Migration ──────────────────────────────────────────────────────

  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS oqron_schedules (
        id              TEXT PRIMARY KEY,
        expression      TEXT,
        timezone        TEXT,
        "missedFirePolicy" TEXT NOT NULL DEFAULT 'skip',
        overlap         INTEGER NOT NULL DEFAULT 1,
        tags            TEXT NOT NULL DEFAULT '[]',
        status          TEXT NOT NULL DEFAULT 'active',

        "runAt"         TEXT,
        "runAfterOpts"  TEXT,
        rrule           TEXT,
        recurring       TEXT,

        "lastRunAt"     TIMESTAMPTZ,
        "nextRunAt"     TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS oqron_jobs (
        id              TEXT PRIMARY KEY,
        "scheduleId"    TEXT REFERENCES oqron_schedules(id) ON DELETE CASCADE,
        status          TEXT NOT NULL,
        "startedAt"     TIMESTAMPTZ NOT NULL,
        "completedAt"   TIMESTAMPTZ,
        error           TEXT,
        result          TEXT,
        "progressPercent" INTEGER,
        "progressLabel" TEXT,
        attempts        INTEGER DEFAULT 1,
        "durationMs"    INTEGER,
        tags            TEXT
      );

      CREATE TABLE IF NOT EXISTS oqron_locks (
        "resourceKey"   TEXT PRIMARY KEY,
        "ownerId"       TEXT NOT NULL,
        "expiresAt"     TIMESTAMPTZ NOT NULL
      );
    `);
  }

  // ── IOqronAdapter Implementation ────────────────────────────────────────

  async upsertSchedule(
    def: CronDefinition | ScheduleDefinition,
  ): Promise<void> {
    const isSchedule =
      "runAt" in def ||
      "rrule" in def ||
      "recurring" in def ||
      "runAfter" in def;

    await this.pool.query(
      `INSERT INTO oqron_schedules (
         id, expression, timezone, "missedFirePolicy", overlap, tags,
         "runAt", "runAfterOpts", rrule, recurring, status
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE SET
         expression         = EXCLUDED.expression,
         timezone           = EXCLUDED.timezone,
         "missedFirePolicy" = EXCLUDED."missedFirePolicy",
         overlap            = EXCLUDED.overlap,
         tags               = EXCLUDED.tags,
         "runAt"            = EXCLUDED."runAt",
         "runAfterOpts"     = EXCLUDED."runAfterOpts",
         rrule              = EXCLUDED.rrule,
         recurring          = EXCLUDED.recurring`,
      [
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
        isSchedule && def.runAt ? (def.runAt as Date).toISOString() : null,
        isSchedule && def.runAfter ? JSON.stringify(def.runAfter) : null,
        isSchedule && def.rrule ? def.rrule : null,
        isSchedule && def.recurring ? JSON.stringify(def.recurring) : null,
        def.status ?? "active",
      ],
    );
  }

  /**
   * Fetch due schedules using `FOR UPDATE SKIP LOCKED`.
   * This is the critical enterprise feature: 50 containers can all
   * call this simultaneously and no two will ever receive the same row.
   */
  async getDueSchedules(
    now: Date,
    limit: number,
    prefix?: string,
  ): Promise<Pick<CronDefinition | ScheduleDefinition, "name">[]> {
    let sql = `
      SELECT id AS name FROM oqron_schedules
      WHERE "nextRunAt" <= $1 AND status = 'active'
    `;
    const params: unknown[] = [now.toISOString()];
    let idx = 2;

    if (prefix) {
      sql += ` AND id LIKE $${idx}`;
      params.push(`${prefix}%`);
      idx++;
    }

    sql += ` ORDER BY "nextRunAt" ASC LIMIT $${idx} FOR UPDATE SKIP LOCKED`;
    params.push(limit);

    const result = await this.pool.query(sql, params);
    return result.rows as { name: string }[];
  }

  async getSchedules(
    prefix?: string,
  ): Promise<
    Array<{ name: string; lastRunAt: Date | null; nextRunAt: Date | null }>
  > {
    let sql = `SELECT id, "lastRunAt", "nextRunAt" FROM oqron_schedules`;
    const params: unknown[] = [];

    if (prefix) {
      sql += ` WHERE id LIKE $1`;
      params.push(`${prefix}%`);
    }

    const result = await this.pool.query(sql, params);
    return result.rows.map((r: any) => ({
      name: r.id,
      lastRunAt: r.lastRunAt ? new Date(r.lastRunAt) : null,
      nextRunAt: r.nextRunAt ? new Date(r.nextRunAt) : null,
    }));
  }

  async updateNextRun(
    scheduleId: string,
    nextRunAt: Date | null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE oqron_schedules SET "nextRunAt" = $1 WHERE id = $2`,
      [nextRunAt ? nextRunAt.toISOString() : null, scheduleId],
    );
  }

  async recordExecution(job: JobRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO oqron_jobs (
         id, "scheduleId", status, "startedAt", "completedAt",
         error, result, attempts, "progressPercent", "progressLabel", "durationMs", tags
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (id) DO UPDATE SET
         status            = EXCLUDED.status,
         "completedAt"     = EXCLUDED."completedAt",
         error             = EXCLUDED.error,
         result            = EXCLUDED.result,
         attempts          = EXCLUDED.attempts,
         "progressPercent" = COALESCE(EXCLUDED."progressPercent", oqron_jobs."progressPercent"),
         "progressLabel"   = COALESCE(EXCLUDED."progressLabel", oqron_jobs."progressLabel"),
         "durationMs"      = EXCLUDED."durationMs",
         tags              = EXCLUDED.tags`,
      [
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
        job.tags ? JSON.stringify(job.tags) : null,
      ],
    );

    if (
      job.scheduleId &&
      (job.status === "completed" || job.status === "failed")
    ) {
      await this.pool.query(
        `UPDATE oqron_schedules SET "lastRunAt" = $1 WHERE id = $2`,
        [(job.completedAt ?? new Date()).toISOString(), job.scheduleId],
      );
    }
  }

  async updateJobProgress(
    id: string,
    progressPercent: number,
    progressLabel?: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE oqron_jobs SET "progressPercent" = $1, "progressLabel" = $2 WHERE id = $3`,
      [progressPercent, progressLabel ?? null, id],
    );
  }

  async getExecutions(
    scheduleId: string,
    opts: { limit: number; offset: number },
  ): Promise<JobRecord[]> {
    const result = await this.pool.query(
      `SELECT id, "scheduleId", status, "startedAt", "completedAt",
              error, result, "progressPercent", "progressLabel", attempts, "durationMs"
       FROM oqron_jobs WHERE "scheduleId" = $1
       ORDER BY "startedAt" DESC
       LIMIT $2 OFFSET $3`,
      [scheduleId, opts.limit, opts.offset],
    );

    return result.rows.map((r: any) => ({
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
    const result = await this.pool.query(
      `SELECT id, "scheduleId", status, "startedAt", "completedAt",
              error, result, "progressPercent", "progressLabel", attempts, "durationMs"
       FROM oqron_jobs WHERE status = 'running'`,
    );

    return result.rows.map((r: any) => ({
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
    const result = await this.pool.query(
      `DELETE FROM oqron_jobs WHERE "startedAt" < $1`,
      [before.toISOString()],
    );
    return result.rowCount ?? 0;
  }

  async pruneHistoryForSchedule(
    scheduleId: string,
    keepJobHistory: number | boolean,
    keepFailedJobHistory: number | boolean,
  ): Promise<void> {
    if (keepJobHistory === false && keepFailedJobHistory === false) return;

    if (typeof keepJobHistory === "number") {
      await this.pool.query(
        `DELETE FROM oqron_jobs
         WHERE "scheduleId" = $1 AND status = 'completed'
         AND id NOT IN (
           SELECT id FROM oqron_jobs
           WHERE "scheduleId" = $1 AND status = 'completed'
           ORDER BY "startedAt" DESC LIMIT $2
         )`,
        [scheduleId, keepJobHistory],
      );
    }

    if (typeof keepFailedJobHistory === "number") {
      await this.pool.query(
        `DELETE FROM oqron_jobs
         WHERE "scheduleId" = $1 AND status IN ('failed', 'dead')
         AND id NOT IN (
           SELECT id FROM oqron_jobs
           WHERE "scheduleId" = $1 AND status IN ('failed', 'dead')
           ORDER BY "startedAt" DESC LIMIT $2
         )`,
        [scheduleId, keepFailedJobHistory],
      );
    }
  }

  async pauseSchedule(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE oqron_schedules SET status = 'paused' WHERE id = $1`,
      [id],
    );
  }

  async resumeSchedule(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE oqron_schedules SET status = 'active' WHERE id = $1`,
      [id],
    );
  }
}
