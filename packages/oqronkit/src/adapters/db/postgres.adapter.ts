import type {
  CronDefinition,
  FlowJobNode,
  IOqronAdapter,
  JobFilter,
  JobStatus,
  OqronJob,
  QueueMetrics,
  ScheduleDefinition,
  SystemStats,
} from "../../core/index.js";

/**
 * PostgresAdapter — Production-grade IOqronAdapter backed by PostgreSQL.
 */
export class PostgresAdapter implements IOqronAdapter {
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
        type            TEXT NOT NULL,
        queue_name      TEXT NOT NULL,
        status          TEXT NOT NULL,
        data            TEXT NOT NULL,
        opts            TEXT NOT NULL,
        attempt_made    INTEGER NOT NULL DEFAULT 0,
        progress_percent INTEGER NOT NULL DEFAULT 0,
        progress_label  TEXT,
        worker_id       TEXT,
        error           TEXT,
        stacktrace      TEXT,
        return_value    TEXT,
        parent_id       TEXT,
        schedule_id     TEXT REFERENCES oqron_schedules(id) ON DELETE CASCADE,
        tags            TEXT NOT NULL DEFAULT '[]',
        created_at      TIMESTAMPTZ NOT NULL,
        started_at      TIMESTAMPTZ,
        finished_at     TIMESTAMPTZ,
        run_at          TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_oqjobs_status ON oqron_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_oqjobs_queue ON oqron_jobs(queue_name);
      CREATE INDEX IF NOT EXISTS idx_oqschedules_next ON oqron_schedules("nextRunAt") WHERE status = 'active';

      CREATE TABLE IF NOT EXISTS oqron_locks (
        "resourceKey"   TEXT PRIMARY KEY,
        "ownerId"       TEXT NOT NULL,
        "expiresAt"     TIMESTAMPTZ NOT NULL
      );
    `);
  }

  // ── Schedules ────────────────────────────────────────────────────────────

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
            (def.intervalMs ? `every:\${def.intervalMs}ms` : null))
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

  async getDueSchedules(now: Date, limit: number): Promise<string[]> {
    const sql = `
      SELECT id FROM oqron_schedules
      WHERE "nextRunAt" <= $1 AND status = 'active'
      ORDER BY "nextRunAt" ASC LIMIT $2 FOR UPDATE SKIP LOCKED
    `;
    const result = await this.pool.query(sql, [now.toISOString(), limit]);
    return result.rows.map((r: any) => r.id);
  }

  async getSchedule(
    id: string,
  ): Promise<CronDefinition | ScheduleDefinition | null> {
    const result = await this.pool.query(
      `SELECT * FROM oqron_schedules WHERE id = $1`,
      [id],
    );
    if (result.rowCount === 0) return null;
    const r = result.rows[0];
    return { name: r.id } as any; // Simplification since usually Engine recreates these internally
  }

  async getSchedules(): Promise<
    Array<{ id: string; lastRunAt: Date | null; nextRunAt: Date | null }>
  > {
    const result = await this.pool.query(
      `SELECT id, "lastRunAt", "nextRunAt" FROM oqron_schedules`,
    );
    return result.rows.map((r: any) => ({
      id: r.id,
      lastRunAt: r.lastRunAt ? new Date(r.lastRunAt) : null,
      nextRunAt: r.nextRunAt ? new Date(r.nextRunAt) : null,
    }));
  }

  async updateScheduleNextRun(
    id: string,
    nextRunAt: Date | null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE oqron_schedules SET "nextRunAt" = $1, "lastRunAt" = $2 WHERE id = $3`,
      [
        nextRunAt ? nextRunAt.toISOString() : null,
        nextRunAt === null ? new Date().toISOString() : null,
        id,
      ],
    );
  }

  async setSchedulePaused(id: string, paused: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE oqron_schedules SET status = $1 WHERE id = $2`,
      [paused ? "paused" : "active", id],
    );
  }

  // ── Jobs ─────────────────────────────────────────────────────────────────

  async upsertJob(job: OqronJob): Promise<void> {
    await this.pool.query(
      `INSERT INTO oqron_jobs (
         id, type, queue_name, status, data, opts, attempt_made, 
         progress_percent, progress_label, worker_id, error, stacktrace, 
         return_value, parent_id, schedule_id, tags, created_at, started_at, 
         finished_at, run_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         attempt_made = EXCLUDED.attempt_made,
         progress_percent = EXCLUDED.progress_percent,
         progress_label = EXCLUDED.progress_label,
         worker_id = EXCLUDED.worker_id,
         error = EXCLUDED.error,
         stacktrace = EXCLUDED.stacktrace,
         return_value = EXCLUDED.return_value,
         started_at = EXCLUDED.started_at,
         finished_at = EXCLUDED.finished_at`,
      [
        job.id,
        job.type,
        job.queueName,
        job.status,
        JSON.stringify(job.data),
        JSON.stringify(job.opts),
        job.attemptMade,
        job.progressPercent,
        job.progressLabel ?? null,
        job.workerId ?? null,
        job.error ?? null,
        job.stacktrace ? JSON.stringify(job.stacktrace) : null,
        job.returnValue !== undefined ? JSON.stringify(job.returnValue) : null,
        job.parentId ?? null,
        job.scheduleId ?? null,
        JSON.stringify(job.tags),
        job.createdAt.toISOString(),
        job.startedAt?.toISOString() ?? null,
        job.finishedAt?.toISOString() ?? null,
        job.runAt?.toISOString() ?? null,
      ],
    );
  }

  async enqueueFlow(flow: FlowJobNode, parentId?: string): Promise<OqronJob> {
    const crypto = await import("crypto");
    const jobId = flow.opts?.jobId ?? crypto.randomUUID();
    const childrenCount = flow.children?.length ?? 0;

    const job: OqronJob = {
      id: jobId,
      type: "task",
      queueName: flow.queueName,
      status:
        childrenCount > 0
          ? "pending"
          : flow.opts?.delay
            ? "delayed"
            : "waiting",
      data: flow.data,
      opts: flow.opts ?? {},
      attemptMade: 0,
      progressPercent: 0,
      parentId,
      tags: [],
      createdAt: new Date(),
    };

    await this.upsertJob(job);
    if (flow.children) {
      for (const child of flow.children) {
        await this.enqueueFlow(child, job.id);
      }
    }
    return job;
  }

  async getJob(id: string): Promise<OqronJob | null> {
    const result = await this.pool.query(
      `SELECT * FROM oqron_jobs WHERE id = $1`,
      [id],
    );
    if (result.rowCount === 0) return null;
    const r = result.rows[0];
    return {
      id: r.id,
      type: r.type,
      queueName: r.queue_name,
      status: r.status as JobStatus,
      data: JSON.parse(r.data),
      opts: JSON.parse(r.opts),
      attemptMade: r.attempt_made,
      progressPercent: r.progress_percent,
      progressLabel: r.progress_label ?? undefined,
      workerId: r.worker_id ?? undefined,
      error: r.error ?? undefined,
      stacktrace: r.stacktrace ? JSON.parse(r.stacktrace) : undefined,
      returnValue: r.return_value ? JSON.parse(r.return_value) : undefined,
      parentId: r.parent_id ?? undefined,
      scheduleId: r.schedule_id ?? undefined,
      tags: JSON.parse(r.tags),
      createdAt: new Date(r.created_at),
      startedAt: r.started_at ? new Date(r.started_at) : undefined,
      finishedAt: r.finished_at ? new Date(r.finished_at) : undefined,
      runAt: r.run_at ? new Date(r.run_at) : undefined,
    } as any;
  }

  async listJobs(filter: JobFilter): Promise<OqronJob[]> {
    let sql = `SELECT * FROM oqron_jobs WHERE 1=1`;
    const params: unknown[] = [];
    let idx = 1;

    if (filter.type) {
      sql += ` AND type = $${idx++}`;
      params.push(filter.type);
    }
    if (filter.status) {
      sql += ` AND status = $${idx++}`;
      params.push(filter.status);
    }
    if (filter.queueName) {
      sql += ` AND queue_name = $${idx++}`;
      params.push(filter.queueName);
    }
    if (filter.scheduleId) {
      sql += ` AND schedule_id = $${idx++}`;
      params.push(filter.scheduleId);
    }

    sql += ` ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(filter.limit ?? 50, filter.offset ?? 0);

    const result = await this.pool.query(sql, params);
    return result.rows.map((r: any) => ({
      id: r.id,
      type: r.type,
      queueName: r.queue_name,
      status: r.status as JobStatus,
      data: JSON.parse(r.data),
      opts: JSON.parse(r.opts),
      attemptMade: r.attempt_made,
      progressPercent: r.progress_percent,
      progressLabel: r.progress_label ?? undefined,
      workerId: r.worker_id ?? undefined,
      error: r.error ?? undefined,
      stacktrace: r.stacktrace ? JSON.parse(r.stacktrace) : undefined,
      returnValue: r.return_value ? JSON.parse(r.return_value) : undefined,
      parentId: r.parent_id ?? undefined,
      scheduleId: r.schedule_id ?? undefined,
      tags: JSON.parse(r.tags),
      createdAt: new Date(r.created_at),
      startedAt: r.started_at ? new Date(r.started_at) : undefined,
      finishedAt: r.finished_at ? new Date(r.finished_at) : undefined,
      runAt: r.run_at ? new Date(r.run_at) : undefined,
    })) as any[];
  }

  async deleteJob(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM oqron_jobs WHERE id = $1`, [id]);
  }

  // ── Metrics ──────────────────────────────────────────────────────────────

  async getQueueMetrics(queueName: string): Promise<QueueMetrics> {
    const result = await this.pool.query(
      `
      SELECT status, COUNT(*) as cnt 
      FROM oqron_jobs 
      WHERE queue_name = $1 
      GROUP BY status
    `,
      [queueName],
    );

    const counts: Record<string, number> = {
      active: 0,
      waiting: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
    };
    for (const r of result.rows) {
      counts[r.status] = parseInt(r.cnt, 10);
    }

    return {
      active: counts.active,
      waiting: counts.waiting,
      completed: counts.completed,
      failed: counts.failed,
      delayed: counts.delayed,
      paused: 0,
    };
  }

  async getSystemStats(): Promise<SystemStats> {
    const cRes = await this.pool.query(
      `SELECT status, COUNT(*) as cnt FROM oqron_jobs GROUP BY status`,
    );
    const jobs: Record<JobStatus, number> = {
      pending: 0,
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      paused: 0,
    };
    for (const r of cRes.rows) {
      if (r.status in jobs) jobs[r.status as JobStatus] = parseInt(r.cnt, 10);
    }

    const sRes = await this.pool.query(
      `SELECT COUNT(*) as cnt FROM oqron_schedules`,
    );
    const wRes = await this.pool.query(
      `SELECT COUNT(DISTINCT worker_id) as cnt FROM oqron_jobs WHERE status = 'active'`,
    );

    return {
      project: "oqronkit",
      env: "pg",
      uptime: process.uptime(),
      counts: {
        jobs,
        schedules: parseInt(sRes.rows[0].cnt, 10),
        activeWorkers: parseInt(wRes.rows[0].cnt, 10),
      },
    };
  }

  async pruneJobs(before: Date, status?: OqronJob["status"]): Promise<number> {
    if (status) {
      const result = await this.pool.query(
        `DELETE FROM oqron_jobs WHERE created_at < $1 AND status = $2`,
        [before.toISOString(), status],
      );
      return result.rowCount ?? 0;
    }
    const result = await this.pool.query(
      `DELETE FROM oqron_jobs WHERE created_at < $1`,
      [before.toISOString()],
    );
    return result.rowCount ?? 0;
  }
}
