import type { CronDefinition } from "./cron.types.js";
import type {
  FlowJobNode,
  JobFilter,
  OqronJob,
  SystemStats,
} from "./job.types.js";
import type { QueueMetrics } from "./queue.types.js";
import type { ScheduleDefinition } from "./scheduler.types.js";

/**
 * IOqronAdapter — The "Brain" of the system.
 * Responsible for all persistent state: schedules, jobs, stats, and historical logs.
 */
export interface IOqronAdapter {
  // ── Schedules (Cron/Scheduler) ─────────────────────────────────────────────

  /** Insert or update a schedule definition */
  upsertSchedule(def: CronDefinition | ScheduleDefinition): Promise<void>;

  /** Get IDs of schedules that are due to fire (nextRunAt <= now) */
  getDueSchedules(now: Date, limit: number): Promise<string[]>;

  /** Get full schedule definition by ID */
  getSchedule(id: string): Promise<CronDefinition | ScheduleDefinition | null>;

  /** Get all registered schedules and their run metadata */
  getSchedules(): Promise<
    Array<{ id: string; lastRunAt: Date | null; nextRunAt: Date | null }>
  >;

  /** Update nextRunAt for a schedule */
  updateScheduleNextRun(id: string, nextRunAt: Date | null): Promise<void>;

  /** Pause/Resume a schedule */
  setSchedulePaused(id: string, paused: boolean): Promise<void>;

  // ── Jobs (Universal) ───────────────────────────────────────────────────────

  /** Create or update a job record */
  upsertJob(job: OqronJob): Promise<void>;

  /** Push a complex parent-child DAG map. Returns the root job. */
  enqueueFlow(flow: FlowJobNode): Promise<OqronJob>;

  /** Fetch a specific job by ID */
  getJob(id: string): Promise<OqronJob | null>;

  /** Query jobs with filtering and pagination */
  listJobs(filter: JobFilter): Promise<OqronJob[]>;

  /** Delete a job record completely (used for cleanup or removeOnComplete) */
  deleteJob(id: string): Promise<void>;

  // ── Stats & Administration ─────────────────────────────────────────────────

  /** Get aggregate metrics for a specific queue */
  getQueueMetrics(queueName: string): Promise<QueueMetrics>;

  /** Get high-level system health and aggregate counts */
  getSystemStats(): Promise<SystemStats>;

  /** Bulk cleanup of old execution records */
  pruneJobs(before: Date, status?: OqronJob["status"]): Promise<number>;
}
