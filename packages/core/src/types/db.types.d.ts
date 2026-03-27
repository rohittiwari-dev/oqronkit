import type { CronDefinition, JobRecord } from "./cron.types.js";
export interface IChronoAdapter {
  /** Insert or update a schedule definition */
  upsertSchedule(def: CronDefinition): Promise<void>;
  /** Get schedules that are due to fire (nextRunAt <= now, or never run) */
  getDueSchedules(
    now: Date,
    limit: number,
  ): Promise<Pick<CronDefinition, "id">[]>;
  /** Record a job execution (insert or update) */
  recordExecution(job: JobRecord): Promise<void>;
  /** Get execution history for a schedule */
  getExecutions(
    scheduleId: string,
    opts: {
      limit: number;
      offset: number;
    },
  ): Promise<JobRecord[]>;
  /** Clean old execution records */
  cleanOldExecutions(before: Date): Promise<number>;
}
//# sourceMappingURL=db.types.d.ts.map
