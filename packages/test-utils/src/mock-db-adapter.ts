import type {
  CronDefinition,
  IChronoAdapter,
  JobRecord,
} from "@chronoforge/core";

/** In-memory adapter for unit testing without a real database */
export class MockDbAdapter implements IChronoAdapter {
  readonly schedules = new Map<string, CronDefinition>();
  readonly jobs = new Map<string, JobRecord>();

  async upsertSchedule(def: CronDefinition): Promise<void> {
    this.schedules.set(def.id, def);
  }

  async getDueSchedules(
    _now: Date,
    limit: number,
  ): Promise<Pick<CronDefinition, "id">[]> {
    return [...this.schedules.values()]
      .slice(0, limit)
      .map((s) => ({ id: s.id }));
  }

  async recordExecution(job: JobRecord): Promise<void> {
    this.jobs.set(job.id, { ...job });
  }

  async getExecutions(
    scheduleId: string,
    opts: { limit: number; offset: number },
  ): Promise<JobRecord[]> {
    const all = [...this.jobs.values()].filter(
      (j) => j.scheduleId === scheduleId,
    );
    return all.slice(opts.offset, opts.offset + opts.limit);
  }

  async cleanOldExecutions(_before: Date): Promise<number> {
    return 0;
  }
}
