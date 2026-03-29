import * as crypto from "node:crypto";
import Database from "better-sqlite3";
import type { CronDefinition } from "../../core/types/cron.types.js";
import type { IOqronAdapter } from "../../core/types/db.types.js";
import type {
  FlowJobNode,
  JobFilter,
  JobStatus,
  OqronJob,
  SystemStats,
} from "../../core/types/job.types.js";
import type { QueueMetrics } from "../../core/types/queue.types.js";
import type { ScheduleDefinition } from "../../core/types/scheduler.types.js";

/**
 * SqliteAdapter — Persistent Storage powered by SQLite.
 * Responsible for all definitions, historical logs, and system metadata.
 */
export class SqliteAdapter implements IOqronAdapter {
  private readonly db: Database.Database;

  constructor(dbOrPath: Database.Database | string = "oqron.sqlite") {
    this.db = typeof dbOrPath === "string" ? new Database(dbOrPath) : dbOrPath;
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      -- Schedule Definitions
      CREATE TABLE IF NOT EXISTS oqron_schedules (
        id                TEXT PRIMARY KEY,
        type              TEXT NOT NULL,
        definition        TEXT NOT NULL,          -- JSON
        status            TEXT NOT NULL DEFAULT 'active',
        last_run_at       TEXT,
        next_run_at       TEXT
      );

      -- Universal Job Store
      CREATE TABLE IF NOT EXISTS oqron_jobs (
        id                TEXT PRIMARY KEY,
        type              TEXT NOT NULL,
        queue_name        TEXT NOT NULL,
        status            TEXT NOT NULL,
        data              TEXT NOT NULL,          -- JSON
        opts              TEXT NOT NULL,          -- JSON
        attempt_made      INTEGER NOT NULL DEFAULT 0,
        progress_percent  INTEGER NOT NULL DEFAULT 0,
        progress_label    TEXT,
        worker_id         TEXT,
        error             TEXT,
        stacktrace        TEXT,                   -- JSON
        return_value      TEXT,                   -- JSON
        parent_id         TEXT,
        schedule_id       TEXT,
        tags              TEXT NOT NULL DEFAULT '[]', -- JSON
        created_at        TEXT NOT NULL,
        started_at        TEXT,
        finished_at       TEXT,
        run_at            TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_oqjobs_status ON oqron_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_oqjobs_queue ON oqron_jobs(queue_name);
      CREATE INDEX IF NOT EXISTS idx_oqschedules_next ON oqron_schedules(next_run_at) WHERE status = 'active';
    `);
  }

  // ── IOqronAdapter (Storage) ─────────────────────────────────────────────

  async upsertSchedule(
    def: CronDefinition | ScheduleDefinition,
  ): Promise<void> {
    this.db
      .prepare(
        `
      INSERT INTO oqron_schedules (id, type, definition, status)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        definition = excluded.definition,
        status = excluded.status
    `,
      )
      .run(
        def.name,
        "cron" in def ? "cron" : "schedule",
        JSON.stringify(def),
        def.status ?? "active",
      );
  }

  async getDueSchedules(now: Date, limit: number): Promise<string[]> {
    const rows = this.db
      .prepare(
        `
      SELECT id FROM oqron_schedules
      WHERE next_run_at <= ? AND status = 'active'
      LIMIT ?
    `,
      )
      .all(now.toISOString(), limit) as { id: string }[];
    return rows.map((r) => r.id);
  }

  async getSchedule(
    id: string,
  ): Promise<CronDefinition | ScheduleDefinition | null> {
    const row = this.db
      .prepare(`SELECT definition FROM oqron_schedules WHERE id = ?`)
      .get(id) as { definition: string } | undefined;
    return row ? JSON.parse(row.definition) : null;
  }

  async getSchedules(): Promise<
    Array<{ id: string; lastRunAt: Date | null; nextRunAt: Date | null }>
  > {
    const rows = this.db
      .prepare(`SELECT id, last_run_at, next_run_at FROM oqron_schedules`)
      .all() as any[];
    return rows.map((r) => ({
      id: r.id,
      lastRunAt: r.last_run_at ? new Date(r.last_run_at) : null,
      nextRunAt: r.next_run_at ? new Date(r.next_run_at) : null,
    }));
  }

  async updateScheduleNextRun(
    id: string,
    nextRunAt: Date | null,
  ): Promise<void> {
    this.db
      .prepare(
        `
      UPDATE oqron_schedules
      SET next_run_at = ?, last_run_at = ?
      WHERE id = ?
    `,
      )
      .run(
        nextRunAt?.toISOString() ?? null,
        nextRunAt === null ? new Date().toISOString() : undefined,
        id,
      );
  }

  async setSchedulePaused(id: string, paused: boolean): Promise<void> {
    this.db
      .prepare(`UPDATE oqron_schedules SET status = ? WHERE id = ?`)
      .run(paused ? "paused" : "active", id);
  }

  async upsertJob(job: OqronJob): Promise<void> {
    this.db
      .prepare(
        `
      INSERT INTO oqron_jobs (
        id, type, queue_name, status, data, opts, attempt_made, 
        progress_percent, progress_label, worker_id, error, stacktrace, 
        return_value, parent_id, schedule_id, tags, created_at, started_at, 
        finished_at, run_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        attempt_made = excluded.attempt_made,
        progress_percent = excluded.progress_percent,
        progress_label = excluded.progress_label,
        worker_id = excluded.worker_id,
        error = excluded.error,
        stacktrace = excluded.stacktrace,
        return_value = excluded.return_value,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at
    `,
      )
      .run(
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
      );
  }

  async getJob(id: string): Promise<OqronJob | null> {
    const row = this.db
      .prepare(`SELECT * FROM oqron_jobs WHERE id = ?`)
      .get(id) as any;
    if (!row) return null;
    return {
      ...row,
      data: JSON.parse(row.data),
      opts: JSON.parse(row.opts),
      tags: JSON.parse(row.tags),
      stacktrace: row.stacktrace ? JSON.parse(row.stacktrace) : undefined,
      returnValue: row.return_value ? JSON.parse(row.return_value) : undefined,
      createdAt: new Date(row.created_at),
      startedAt: row.started_at ? new Date(row.started_at) : undefined,
      finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
      runAt: row.run_at ? new Date(row.run_at) : undefined,
    } as any;
  }

  async listJobs(filter: JobFilter): Promise<OqronJob[]> {
    let sql = `SELECT * FROM oqron_jobs WHERE 1=1`;
    const params: any[] = [];

    if (filter.type) {
      sql += ` AND type = ?`;
      params.push(filter.type);
    }
    if (filter.status) {
      sql += ` AND status = ?`;
      params.push(filter.status);
    }
    if (filter.queueName) {
      sql += ` AND queue_name = ?`;
      params.push(filter.queueName);
    }
    if (filter.scheduleId) {
      sql += ` AND schedule_id = ?`;
      params.push(filter.scheduleId);
    }

    sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(filter.limit ?? 50, filter.offset ?? 0);

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(
      (r) =>
        ({
          ...r,
          data: JSON.parse(r.data),
          opts: JSON.parse(r.opts),
          tags: JSON.parse(r.tags),
          createdAt: new Date(r.created_at),
        }) as any,
    );
  }

  async deleteJob(id: string): Promise<void> {
    this.db.prepare(`DELETE FROM oqron_jobs WHERE id = ?`).run(id);
  }

  async enqueueFlow(flow: FlowJobNode, parentId?: string): Promise<OqronJob> {
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

  async getQueueMetrics(queueName: string): Promise<QueueMetrics> {
    const row = this.db
      .prepare(
        `
      SELECT 
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END) as waiting,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'delayed' THEN 1 ELSE 0 END) as delayed
      FROM oqron_jobs WHERE queue_name = ?
    `,
      )
      .get(queueName) as any;

    return {
      active: row.active ?? 0,
      waiting: row.waiting ?? 0,
      completed: row.completed ?? 0,
      failed: row.failed ?? 0,
      delayed: row.delayed ?? 0,
      paused: 0, // TBD
    };
  }

  async getSystemStats(): Promise<SystemStats> {
    const counts = this.db
      .prepare(
        `
      SELECT status, COUNT(*) as cnt FROM oqron_jobs GROUP BY status
    `,
      )
      .all() as { status: string; cnt: number }[];

    const jobs: Record<JobStatus, number> = {
      pending: 0,
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      paused: 0,
    };
    for (const c of counts) {
      if (c.status in jobs) jobs[c.status as JobStatus] = c.cnt;
    }

    return {
      project: "oqron-sqlite",
      env: "monolith",
      uptime: process.uptime(),
      counts: {
        jobs,
        schedules: (
          this.db
            .prepare(`SELECT COUNT(*) as cnt FROM oqron_schedules`)
            .get() as any
        ).cnt,
        activeWorkers: (
          this.db
            .prepare(
              `SELECT COUNT(DISTINCT worker_id) as cnt FROM oqron_jobs WHERE status = 'active'`,
            )
            .get() as any
        ).cnt,
      },
    };
  }

  async pruneJobs(before: Date, status?: OqronJob["status"]): Promise<number> {
    let sql = `DELETE FROM oqron_jobs WHERE created_at < ?`;
    const params: any[] = [before.toISOString()];
    if (status) {
      sql += ` AND status = ?`;
      params.push(status);
    }
    return this.db.prepare(sql).run(...params).changes;
  }
}
