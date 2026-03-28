import type {
  CronDefinition,
  IChronoAdapter,
  JobRecord,
  ScheduleDefinition,
} from "../../core/index.js";

export class NamespacedChronoAdapter implements IChronoAdapter {
  private readonly prefix: string;

  constructor(
    private readonly base: IChronoAdapter,
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

  async upsertSchedule(
    def: CronDefinition | ScheduleDefinition,
  ): Promise<void> {
    return this.base.upsertSchedule({ ...def, name: this.ns(def.name) });
  }

  async getDueSchedules(
    now: Date,
    limit: number,
    prefix?: string,
  ): Promise<Pick<CronDefinition | ScheduleDefinition, "name">[]> {
    const combinedPrefix = prefix ? `${this.prefix}${prefix}` : this.prefix;
    const records = await this.base.getDueSchedules(now, limit, combinedPrefix);
    return records
      .filter((r) => r.name.startsWith(this.prefix))
      .map((r) => ({ name: this.un(r.name) }));
  }

  async getSchedules(
    prefix?: string,
  ): Promise<
    Array<{ name: string; lastRunAt: Date | null; nextRunAt: Date | null }>
  > {
    const combinedPrefix = prefix ? `${this.prefix}${prefix}` : this.prefix;
    const records = await this.base.getSchedules(combinedPrefix);
    return records
      .filter((r) => r.name.startsWith(this.prefix))
      .map((r) => ({
        ...r,
        name: this.un(r.name),
      }));
  }

  async updateNextRun(
    scheduleId: string,
    nextRunAt: Date | null,
  ): Promise<void> {
    return this.base.updateNextRun(this.ns(scheduleId), nextRunAt);
  }

  async recordExecution(job: JobRecord): Promise<void> {
    return this.base.recordExecution({
      ...job,
      scheduleId: job.scheduleId ? this.ns(job.scheduleId) : undefined,
    });
  }

  async updateJobProgress(
    id: string,
    progressPercent: number,
    progressLabel?: string,
  ): Promise<void> {
    return this.base.updateJobProgress(id, progressPercent, progressLabel);
  }

  async getExecutions(
    scheduleId: string,
    opts: { limit: number; offset: number },
  ): Promise<JobRecord[]> {
    const records = await this.base.getExecutions(this.ns(scheduleId), opts);
    return records.map((r) => ({
      ...r,
      scheduleId: r.scheduleId ? this.un(r.scheduleId) : undefined,
    }));
  }

  async getActiveJobs(): Promise<JobRecord[]> {
    const records = await this.base.getActiveJobs();
    return records
      .filter((r) => r.scheduleId?.startsWith(this.prefix))
      .map((r) => ({
        ...r,
        scheduleId: r.scheduleId ? this.un(r.scheduleId) : undefined,
      }));
  }

  async cleanOldExecutions(before: Date): Promise<number> {
    // Note: cleanOldExecutions operates system-wide currently,
    // depending on the adapter implementation. We pass it through.
    return this.base.cleanOldExecutions(before);
  }

  async pruneHistoryForSchedule(
    scheduleId: string,
    keepJobHistory: number | boolean,
    keepFailedJobHistory: number | boolean,
  ): Promise<void> {
    return this.base.pruneHistoryForSchedule(
      this.ns(scheduleId),
      keepJobHistory,
      keepFailedJobHistory,
    );
  }
}
