import type {
  CronDefinition,
  IOqronAdapter,
  JobFilter,
  OqronJob,
  QueueMetrics,
  ScheduleDefinition,
  SystemStats,
} from "../../core/index.js";

/**
 * Wraps an IOqronAdapter to isolate data by project and environment.
 */
export class NamespacedOqronAdapter implements IOqronAdapter {
  private readonly prefix: string;

  constructor(
    private readonly base: IOqronAdapter,
    project: string = "default",
    environment: string = "development",
  ) {
    this.prefix = `${project}:${environment}:`;
  }

  private ns(id: string): string {
    return `${this.prefix}${id}`;
  }

  private un(id: string): string {
    return id.startsWith(this.prefix) ? id.slice(this.prefix.length) : id;
  }

  // ── Schedules ──────────────────────────────────────────────────────────────

  async upsertSchedule(
    def: CronDefinition | ScheduleDefinition,
  ): Promise<void> {
    return this.base.upsertSchedule({ ...def, name: this.ns(def.name) });
  }

  async getDueSchedules(now: Date, limit: number): Promise<string[]> {
    const rawIds = await this.base.getDueSchedules(now, limit);
    return rawIds
      .filter((id) => id.startsWith(this.prefix))
      .map((id) => this.un(id));
  }

  async getSchedule(
    id: string,
  ): Promise<CronDefinition | ScheduleDefinition | null> {
    const s = await this.base.getSchedule(this.ns(id));
    if (!s) return null;
    return { ...s, name: this.un(s.name) };
  }

  async getSchedules(): Promise<
    Array<{ id: string; lastRunAt: Date | null; nextRunAt: Date | null }>
  > {
    const records = await this.base.getSchedules();
    return records
      .filter((r) => r.id.startsWith(this.prefix))
      .map((r) => ({ ...r, id: this.un(r.id) }));
  }

  async updateScheduleNextRun(
    id: string,
    nextRunAt: Date | null,
  ): Promise<void> {
    return this.base.updateScheduleNextRun(this.ns(id), nextRunAt);
  }

  async setSchedulePaused(id: string, paused: boolean): Promise<void> {
    return this.base.setSchedulePaused(this.ns(id), paused);
  }

  // ── Jobs ───────────────────────────────────────────────────────────────────

  async upsertJob(job: OqronJob): Promise<void> {
    const nsJob = {
      ...job,
      id: this.ns(job.id),
      scheduleId: job.scheduleId ? this.ns(job.scheduleId) : undefined,
      parentId: job.parentId ? this.ns(job.parentId) : undefined,
    };
    return this.base.upsertJob(nsJob);
  }

  async enqueueFlow(flow: any): Promise<OqronJob> {
    // Basic namespace wrapping for flow nodes
    const nsFlow = { ...flow, job: { ...flow.job, id: this.ns(flow.job.id) } };
    const root = await this.base.enqueueFlow(nsFlow);
    return { ...root, id: this.un(root.id) };
  }

  async getJob(id: string): Promise<OqronJob | null> {
    const job = await this.base.getJob(this.ns(id));
    if (!job) return null;
    return {
      ...job,
      id: this.un(job.id),
      scheduleId: job.scheduleId ? this.un(job.scheduleId) : undefined,
      parentId: job.parentId ? this.un(job.parentId) : undefined,
    };
  }

  async listJobs(filter: JobFilter): Promise<OqronJob[]> {
    const safeFilter = {
      ...filter,
      scheduleId: filter.scheduleId ? this.ns(filter.scheduleId) : undefined,
    };
    const jobs = await this.base.listJobs(safeFilter);
    return jobs
      .filter((j) => j.id.startsWith(this.prefix))
      .map((j) => ({
        ...j,
        id: this.un(j.id),
        scheduleId: j.scheduleId ? this.un(j.scheduleId) : undefined,
        parentId: j.parentId ? this.un(j.parentId) : undefined,
      }));
  }

  async deleteJob(id: string): Promise<void> {
    return this.base.deleteJob(this.ns(id));
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  async getQueueMetrics(queueName: string): Promise<QueueMetrics> {
    return this.base.getQueueMetrics(queueName);
  }

  async getSystemStats(): Promise<SystemStats> {
    return this.base.getSystemStats();
  }

  async pruneJobs(before: Date, status?: OqronJob["status"]): Promise<number> {
    return this.base.pruneJobs(before, status);
  }
}
