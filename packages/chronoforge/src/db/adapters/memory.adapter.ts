import type { CronDefinition, JobRecord } from "../../core/types/cron.types.js";
import type { IChronoAdapter } from "../../core/types/db.types.js";
import type { ScheduleDefinition } from "../../core/types/scheduler.types.js";

interface MemSchedule {
  name: string;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
}

export class MemoryChronoAdapter implements IChronoAdapter {
  private schedules = new Map<string, MemSchedule>();
  private jobs = new Map<string, JobRecord>();

  async upsertSchedule(
    def: CronDefinition | ScheduleDefinition,
  ): Promise<void> {
    if (!this.schedules.has(def.name)) {
      this.schedules.set(def.name, {
        name: def.name,
        nextRunAt: null,
        lastRunAt: null,
      });
    }
  }

  async getDueSchedules(
    now: Date,
    limit: number,
  ): Promise<Pick<CronDefinition | ScheduleDefinition, "name">[]> {
    const due: { name: string }[] = [];
    for (const s of this.schedules.values()) {
      if (s.nextRunAt === null || s.nextRunAt <= now) {
        due.push({ name: s.name });
      }
      if (due.length >= limit) break;
    }
    return due;
  }

  async getSchedules(): Promise<
    Array<{ name: string; lastRunAt: Date | null; nextRunAt: Date | null }>
  > {
    return Array.from(this.schedules.values()).map((s) => ({
      name: s.name,
      lastRunAt: s.lastRunAt,
      nextRunAt: s.nextRunAt,
    }));
  }

  async updateNextRun(
    scheduleId: string,
    nextRunAt: Date | null,
  ): Promise<void> {
    const s = this.schedules.get(scheduleId);
    if (s) {
      s.nextRunAt = nextRunAt;
    }
  }

  async recordExecution(job: JobRecord): Promise<void> {
    const existing = this.jobs.get(job.id);
    if (existing) {
      this.jobs.set(job.id, {
        ...existing,
        ...job,
        progressPercent: job.progressPercent ?? existing.progressPercent,
        progressLabel: job.progressLabel ?? existing.progressLabel,
      });
    } else {
      this.jobs.set(job.id, { ...job });
    }

    if (
      job.scheduleId &&
      (job.status === "completed" || job.status === "failed")
    ) {
      const s = this.schedules.get(job.scheduleId);
      if (s) {
        s.lastRunAt = job.completedAt ?? new Date();
      }
    }
  }

  async updateJobProgress(
    id: string,
    progressPercent: number,
    progressLabel?: string,
  ): Promise<void> {
    const job = this.jobs.get(id);
    if (job) {
      job.progressPercent = progressPercent;
      job.progressLabel = progressLabel ?? job.progressLabel;
    }
  }

  async getExecutions(
    scheduleId: string,
    opts: { limit: number; offset: number },
  ): Promise<JobRecord[]> {
    const records = Array.from(this.jobs.values())
      .filter((j) => j.scheduleId === scheduleId)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    return records.slice(opts.offset, opts.offset + opts.limit);
  }

  async getActiveJobs(): Promise<JobRecord[]> {
    return Array.from(this.jobs.values()).filter((j) => j.status === "running");
  }

  async cleanOldExecutions(before: Date): Promise<number> {
    let removed = 0;
    for (const [id, job] of this.jobs.entries()) {
      if (job.startedAt < before) {
        this.jobs.delete(id);
        removed++;
      }
    }
    return removed;
  }

  async pruneHistoryForSchedule(
    scheduleId: string,
    keepJobHistory: number | boolean,
    keepFailedJobHistory: number | boolean,
  ): Promise<void> {
    if (keepJobHistory === false && keepFailedJobHistory === false) return;

    const all = Array.from(this.jobs.values()).filter(
      (j) =>
        j.scheduleId === scheduleId &&
        ["completed", "failed", "dead"].includes(j.status),
    );

    all.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

    const successes = all.filter((j) => j.status === "completed");
    const failures = all.filter((j) => ["failed", "dead"].includes(j.status));

    if (
      typeof keepJobHistory === "number" &&
      successes.length > keepJobHistory
    ) {
      const toRemove = successes.slice(keepJobHistory);
      for (const j of toRemove) this.jobs.delete(j.id);
    }

    if (
      typeof keepFailedJobHistory === "number" &&
      failures.length > keepFailedJobHistory
    ) {
      const toRemove = failures.slice(keepFailedJobHistory);
      for (const j of toRemove) this.jobs.delete(j.id);
    }
  }
}
