import * as crypto from "node:crypto";
import type { CronDefinition } from "../core/types/cron.types.js";
import type { IOqronAdapter } from "../core/types/db.types.js";
import type {
  FlowJobNode,
  JobFilter,
  JobStatus,
  OqronJob,
  SystemStats,
} from "../core/types/job.types.js";
import type { IQueueAdapter, QueueMetrics } from "../core/types/queue.types.js";
import type { ScheduleDefinition } from "../core/types/scheduler.types.js";

/**
 * MemoryAdapter — Lightweight, in-process storage and broker.
 * Implements both IOqronAdapter (Storage) and IQueueAdapter (Broker).
 * Ideal for development, testing, and single-node monolithic applications.
 */
export class MemoryAdapter implements IOqronAdapter, IQueueAdapter {
  private schedules = new Map<string, CronDefinition | ScheduleDefinition>();
  private scheduleMetadata = new Map<
    string,
    { lastRunAt: Date | null; nextRunAt: Date | null; paused: boolean }
  >();
  private jobs = new Map<string, OqronJob>();

  // Broker State
  private waitingLists = new Map<string, string[]>(); // queueName -> jobId[]
  private delayedJobs = new Map<string, { runAt: number; jobId: string }[]>(); // queueName -> delayed[]
  private activeLocks = new Map<
    string,
    { workerId: string; expiresAt: number }
  >(); // jobId -> lock
  private pausedQueues = new Set<string>();
  private limiterHistories = new Map<string, number[]>();

  // ── IOqronAdapter (Storage) ─────────────────────────────────────────────

  async upsertSchedule(
    def: CronDefinition | ScheduleDefinition,
  ): Promise<void> {
    this.schedules.set(def.name, def);
    if (!this.scheduleMetadata.has(def.name)) {
      this.scheduleMetadata.set(def.name, {
        lastRunAt: null,
        nextRunAt: null,
        paused: def.status === "paused",
      });
    }
  }

  async getDueSchedules(now: Date, limit: number): Promise<string[]> {
    const due: string[] = [];
    const nowMs = now.getTime();

    for (const [id, meta] of this.scheduleMetadata.entries()) {
      if (!meta.paused && meta.nextRunAt && meta.nextRunAt.getTime() <= nowMs) {
        due.push(id);
      }
      if (due.length >= limit) break;
    }
    return due;
  }

  async getSchedule(
    id: string,
  ): Promise<CronDefinition | ScheduleDefinition | null> {
    const def = this.schedules.get(id);
    if (!def) return null;
    const meta = this.scheduleMetadata.get(id);
    return { ...def, status: meta?.paused ? "paused" : "active" };
  }

  async getSchedules(): Promise<
    Array<{ id: string; lastRunAt: Date | null; nextRunAt: Date | null }>
  > {
    return Array.from(this.scheduleMetadata.entries()).map(([id, meta]) => ({
      id,
      lastRunAt: meta.lastRunAt,
      nextRunAt: meta.nextRunAt,
    }));
  }

  async updateScheduleNextRun(
    id: string,
    nextRunAt: Date | null,
  ): Promise<void> {
    const meta = this.scheduleMetadata.get(id);
    if (meta) {
      meta.nextRunAt = nextRunAt;
      if (nextRunAt === null) {
        meta.lastRunAt = new Date();
      }
    }
  }

  async setSchedulePaused(id: string, paused: boolean): Promise<void> {
    const meta = this.scheduleMetadata.get(id);
    if (meta) meta.paused = paused;
  }

  async upsertJob(job: OqronJob): Promise<void> {
    this.jobs.set(job.id, { ...job });
  }

  async getJob(id: string): Promise<OqronJob | null> {
    const job = this.jobs.get(id);
    return job ? { ...job } : null;
  }

  async listJobs(filter: JobFilter): Promise<OqronJob[]> {
    let results = Array.from(this.jobs.values());

    if (filter.type) results = results.filter((j) => j.type === filter.type);
    if (filter.status)
      results = results.filter((j) => j.status === filter.status);
    if (filter.queueName)
      results = results.filter((j) => j.queueName === filter.queueName);
    if (filter.scheduleId)
      results = results.filter((j) => j.scheduleId === filter.scheduleId);
    if (filter.tags) {
      results = results.filter((j) =>
        filter.tags!.every((t) => j.tags.includes(t)),
      );
    }

    // Sort by creation desc
    results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 50;
    return results.slice(offset, offset + limit);
  }

  async deleteJob(id: string): Promise<void> {
    this.jobs.delete(id);
  }

  async getQueueMetrics(queueName: string): Promise<QueueMetrics> {
    const jobs = Array.from(this.jobs.values()).filter(
      (j) => j.queueName === queueName,
    );
    return {
      active: jobs.filter((j) => j.status === "active").length,
      waiting: jobs.filter((j) => j.status === "waiting").length,
      completed: jobs.filter((j) => j.status === "completed").length,
      failed: jobs.filter((j) => j.status === "failed").length,
      delayed: jobs.filter((j) => j.status === "delayed").length,
      paused: this.pausedQueues.has(queueName) ? 1 : 0,
    };
  }

  async pruneJobs(before: Date, status?: OqronJob["status"]): Promise<number> {
    let count = 0;
    for (const [id, job] of this.jobs) {
      if (job.createdAt < before && (!status || job.status === status)) {
        this.jobs.delete(id);
        count++;
      }
    }
    return count;
  }

  async getSystemStats(): Promise<SystemStats> {
    const jobArray = Array.from(this.jobs.values());
    const jobs: Record<JobStatus, number> = {
      pending: 0,
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      paused: 0,
    };

    for (const j of jobArray) {
      jobs[j.status]++;
    }

    return {
      project: "oqron-memory",
      env: "development",
      uptime: process.uptime(),
      counts: {
        jobs,
        schedules: this.schedules.size,
        activeWorkers: new Set(
          jobArray.filter((j) => j.status === "active").map((j) => j.workerId),
        ).size,
      },
    };
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

    this.jobs.set(jobId, job);

    if (childrenCount > 0) {
      for (const child of flow.children!) {
        await this.enqueueFlow(child, jobId);
      }
    } else {
      // If leaf node, signal broker
      await this.signalEnqueue(flow.queueName, jobId, flow.opts?.delay);
    }

    return job;
  }

  // ── IQueueAdapter (Broker) ──────────────────────────────────────────────

  async signalEnqueue(
    queueName: string,
    jobId: string,
    delayMs?: number,
  ): Promise<void> {
    if (delayMs && delayMs > 0) {
      const list = this.delayedJobs.get(queueName) || [];
      list.push({ runAt: Date.now() + delayMs, jobId });
      this.delayedJobs.set(queueName, list);
    } else {
      const list = this.waitingLists.get(queueName) || [];
      list.push(jobId);
      this.waitingLists.set(queueName, list);
    }
  }

  async claimJobIds(
    queueName: string,
    workerId: string,
    limit: number,
    lockTtlMs: number,
    limiter?: { max: number; duration: number; groupKey?: string },
  ): Promise<string[]> {
    if (this.pausedQueues.has(queueName)) return [];

    const now = Date.now();

    // 1. Promote delayed
    const delayed = this.delayedJobs.get(queueName) || [];
    const due = delayed.filter((d) => d.runAt <= now);
    if (due.length > 0) {
      const waiting = this.waitingLists.get(queueName) || [];
      for (const d of due) {
        waiting.push(d.jobId);
        const job = this.jobs.get(d.jobId);
        if (job) job.status = "waiting";
      }
      this.waitingLists.set(queueName, waiting);
      this.delayedJobs.set(
        queueName,
        delayed.filter((d) => d.runAt > now),
      );
    }

    // 2. Limiter check
    if (limiter) {
      const groupKey = limiter.groupKey ?? "default";
      const limitKey = `${queueName}:${groupKey}`;
      let history = this.limiterHistories.get(limitKey) || [];
      history = history.filter((ts: number) => ts > now - limiter.duration);
      this.limiterHistories.set(limitKey, history);

      if (history.length >= limiter.max) {
        return [];
      }
    }

    // 3. Claim waiting
    const waiting = this.waitingLists.get(queueName) || [];
    const claimLimit = limiter
      ? Math.min(
          limit,
          limiter.max -
            (this.limiterHistories.get(
              `${queueName}:${limiter.groupKey ?? "default"}`,
            )?.length ?? 0),
        )
      : limit;
    const claimedIds = waiting.splice(0, claimLimit);
    this.waitingLists.set(queueName, waiting);

    for (const id of claimedIds) {
      this.activeLocks.set(id, { workerId, expiresAt: now + lockTtlMs });
      const job = this.jobs.get(id);
      if (job) {
        job.status = "active";
        job.workerId = workerId;
        job.startedAt = new Date();
      }

      if (limiter) {
        const groupKey = limiter.groupKey ?? "default";
        const limitKey = `${queueName}:${groupKey}`;
        const history = this.limiterHistories.get(limitKey) || [];
        history.push(now);
        this.limiterHistories.set(limitKey, history);
      }
    }

    return claimedIds;
  }

  async extendLock(
    jobId: string,
    workerId: string,
    lockTtlMs: number,
  ): Promise<void> {
    const lock = this.activeLocks.get(jobId);
    if (!lock || lock.workerId !== workerId)
      throw new Error("Lock lost or stolen");
    lock.expiresAt = Date.now() + lockTtlMs;
  }

  async ack(jobId: string): Promise<void> {
    this.activeLocks.delete(jobId);
    // Note: Job stays in DB part (this.jobs) until pruned or explicitly deleted
  }

  async setQueuePaused(queueName: string, paused: boolean): Promise<void> {
    if (paused) this.pausedQueues.add(queueName);
    else this.pausedQueues.delete(queueName);
  }

  async ping(): Promise<boolean> {
    return true;
  }
}
