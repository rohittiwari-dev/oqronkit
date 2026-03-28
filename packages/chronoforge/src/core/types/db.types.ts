import type { CronDefinition, JobRecord } from "./cron.types.js";

export interface IChronoAdapter {
  /** Insert or update a schedule definition */
  upsertSchedule(def: CronDefinition): Promise<void>;

  /** Get schedules that are due to fire (nextRunAt <= now, or never run) */
  getDueSchedules(
    now: Date,
    limit: number,
  ): Promise<Pick<CronDefinition, "name">[]>;

  /** Get all registered schedules and their run metadata */
  getSchedules(): Promise<
    Array<{ name: string; lastRunAt: Date | null; nextRunAt: Date | null }>
  >;

  /** Update nextRunAt for a schedule */
  updateNextRun(scheduleId: string, nextRunAt: Date): Promise<void>;

  /** Record a job execution (insert or update) */
  recordExecution(job: JobRecord): Promise<void>;

  /** Get execution history for a schedule */
  getExecutions(
    scheduleId: string,
    opts: { limit: number; offset: number },
  ): Promise<JobRecord[]>;

  /** Get all jobs currently marked as running */
  getActiveJobs(): Promise<JobRecord[]>;

  /** Clean old execution records */
  cleanOldExecutions(before: Date): Promise<number>;
}
