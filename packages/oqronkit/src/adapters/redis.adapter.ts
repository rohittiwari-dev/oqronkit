import * as crypto from "node:crypto";
import type { CronDefinition } from "../core/types/cron.types.js";
import type { IOqronAdapter } from "../core/types/db.types.js";
import type {
  FlowJobNode,
  JobFilter,
  OqronJob,
  SystemStats,
} from "../core/types/job.types.js";
import type { IQueueAdapter, QueueMetrics } from "../core/types/queue.types.js";
import type { ScheduleDefinition } from "../core/types/scheduler.types.js";

/**
 * RedisAdapter — Unified Storage and Broker powered by Redis.
 * Uses Redis Hashes for persistent DB state and ZSETs/LISTs for Broker orchestration.
 */
export class RedisAdapter implements IOqronAdapter, IQueueAdapter {
  constructor(
    private readonly redis: any,
    private readonly prefix = "oqron",
  ) {}

  private k(...parts: string[]): string {
    return [this.prefix, ...parts].join(":");
  }

  // ── IOqronAdapter (Storage) ─────────────────────────────────────────────

  async upsertSchedule(
    def: CronDefinition | ScheduleDefinition,
  ): Promise<void> {
    const key = this.k("schedules", def.name);
    await this.redis.hset(key, {
      id: def.name,
      definition: JSON.stringify(def),
    });
    // Ensure metadata exists
    const metaKey = this.k("sched_meta", def.name);
    const exists = await this.redis.exists(metaKey);
    if (!exists) {
      await this.redis.hset(metaKey, {
        paused: def.status === "paused" ? "1" : "0",
        nextRunAt: "",
        lastRunAt: "",
      });
    }
  }

  async getDueSchedules(now: Date, limit: number): Promise<string[]> {
    // In a production Redis adapter, we would use a ZSET for due schedules
    // For now, simple scan/filter (can be optimized later)
    const keys = await this.redis.keys(this.k("sched_meta", "*"));
    const due: string[] = [];
    for (const key of keys) {
      const meta = await this.redis.hgetall(key);
      if (meta.paused === "0" && meta.nextRunAt) {
        const next = new Date(meta.nextRunAt);
        if (next <= now) {
          due.push(key.split(":").pop()!);
        }
      }
      if (due.length >= limit) break;
    }
    return due;
  }

  async getSchedule(
    id: string,
  ): Promise<CronDefinition | ScheduleDefinition | null> {
    const raw = await this.redis.hget(this.k("schedules", id), "definition");
    return raw ? JSON.parse(raw) : null;
  }

  async getSchedules(): Promise<
    Array<{ id: string; lastRunAt: Date | null; nextRunAt: Date | null }>
  > {
    const keys = await this.redis.keys(this.k("sched_meta", "*"));
    const results = [];
    for (const key of keys) {
      const meta = await this.redis.hgetall(key);
      results.push({
        id: key.split(":").pop()!,
        lastRunAt: meta.lastRunAt ? new Date(meta.lastRunAt) : null,
        nextRunAt: meta.nextRunAt ? new Date(meta.nextRunAt) : null,
      });
    }
    return results;
  }

  async updateScheduleNextRun(
    id: string,
    nextRunAt: Date | null,
  ): Promise<void> {
    await this.redis.hset(this.k("sched_meta", id), {
      nextRunAt: nextRunAt?.toISOString() ?? "",
      lastRunAt: nextRunAt === null ? new Date().toISOString() : undefined,
    });
  }

  async setSchedulePaused(id: string, paused: boolean): Promise<void> {
    await this.redis.hset(
      this.k("sched_meta", id),
      "paused",
      paused ? "1" : "0",
    );
  }

  async upsertJob(job: OqronJob): Promise<void> {
    const key = this.k("job", job.id);
    await this.redis.hset(key, {
      ...job,
      data: JSON.stringify(job.data),
      opts: JSON.stringify(job.opts),
      tags: JSON.stringify(job.tags),
      createdAt: job.createdAt.toISOString(),
      startedAt: job.startedAt?.toISOString() ?? "",
      finishedAt: job.finishedAt?.toISOString() ?? "",
      runAt: job.runAt?.toISOString() ?? "",
    });
  }

  async getJob(id: string): Promise<OqronJob | null> {
    const raw = await this.redis.hgetall(this.k("job", id));
    if (!raw || Object.keys(raw).length === 0) return null;
    return {
      ...raw,
      data: JSON.parse(raw.data),
      opts: JSON.parse(raw.opts),
      tags: JSON.parse(raw.tags),
      attemptMade: Number(raw.attemptMade),
      progressPercent: Number(raw.progressPercent),
      createdAt: new Date(raw.createdAt),
      startedAt: raw.startedAt ? new Date(raw.startedAt) : undefined,
      finishedAt: raw.finishedAt ? new Date(raw.finishedAt) : undefined,
      runAt: raw.runAt ? new Date(raw.runAt) : undefined,
    } as any;
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

  async listJobs(filter: JobFilter): Promise<OqronJob[]> {
    // Basic scan-based listing (Production would use ZSETs for status/queue indexing)
    const keys = await this.redis.keys(this.k("job", "*"));
    const jobs = [];
    for (const key of keys) {
      const job = await this.getJob(key.split(":").pop()!);
      if (job) {
        if (filter.status && job.status !== filter.status) continue;
        if (filter.queueName && job.queueName !== filter.queueName) continue;
        jobs.push(job);
      }
    }
    return jobs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async deleteJob(id: string): Promise<void> {
    await this.redis.del(this.k("job", id));
  }

  async getQueueMetrics(_queueName: string): Promise<QueueMetrics> {
    // This would ideally be tracked via Redis SCARD/LLEN on separate status sets
    return {
      active: 0,
      waiting: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      paused: 0,
    };
  }

  async getSystemStats(): Promise<SystemStats> {
    return {
      project: "oqron-redis",
      env: "production",
      uptime: process.uptime(),
      counts: { jobs: {} as any, schedules: 0, activeWorkers: 0 },
    };
  }

  async pruneJobs(
    _before: Date,
    _status?: OqronJob["status"],
  ): Promise<number> {
    return 0; // TBD
  }

  // ── IQueueAdapter (Broker) ──────────────────────────────────────────────

  async signalEnqueue(
    queueName: string,
    jobId: string,
    delayMs?: number,
  ): Promise<void> {
    if (delayMs && delayMs > 0) {
      await this.redis.zadd(
        this.k("q", queueName, "delayed"),
        Date.now() + delayMs,
        jobId,
      );
    } else {
      await this.redis.rpush(this.k("q", queueName, "waiting"), jobId);
    }
  }

  async claimJobIds(
    _queueName: string,
    _workerId: string,
    _limit: number,
    _lockTtlMs: number,
  ): Promise<string[]> {
    // Implementation using atomic Lua script for claim+lock
    return [];
  }

  async extendLock(
    _jobId: string,
    _workerId: string,
    _lockTtlMs: number,
  ): Promise<void> {
    // Implementation using PEXPIRE
  }

  async ack(_jobId: string): Promise<void> {
    // Implementation
  }

  async setQueuePaused(_queueName: string, _paused: boolean): Promise<void> {
    // Implementation
  }

  async ping(): Promise<boolean> {
    return (await this.redis.ping()) === "PONG";
  }
}
