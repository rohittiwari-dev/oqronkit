import type { CronDefinition, JobRecord } from "./types/cron.types.js";
import type { IOqronAdapter } from "./types/db.types.js";
import type { ILockAdapter } from "./types/lock.types.js";
import type { ScheduleDefinition } from "./types/scheduler.types.js";

/**
 * Create a custom database adapter by providing implementations for the IOqronAdapter interface.
 *
 * This factory validates that all required methods are provided and returns a typed adapter
 * that OqronKit can use directly in the config.
 *
 * @example
 * ```ts
 * import { createDbAdapter, defineConfig } from "oqronkit";
 *
 * const myAdapter = createDbAdapter({
 *   name: "turso",
 *
 *   async upsertSchedule(def) {
 *     await tursoClient.execute("INSERT OR REPLACE INTO schedules ...", [def.name]);
 *   },
 *
 *   async getDueSchedules(now, limit, prefix) {
 *     const rows = await tursoClient.execute("SELECT name FROM schedules WHERE ...");
 *     return rows.map(r => ({ name: r.name }));
 *   },
 *
 *   async getSchedules(prefix) { ... },
 *   async updateNextRun(scheduleId, nextRunAt) { ... },
 *   async recordExecution(job) { ... },
 *   async updateJobProgress(id, percent, label) { ... },
 *   async getExecutions(scheduleId, opts) { ... },
 *   async getActiveJobs() { ... },
 *   async cleanOldExecutions(before) { ... },
 *   async pruneHistoryForSchedule(scheduleId, keep, keepFailed) { ... },
 *   async pauseSchedule(scheduleId) { ... },
 *   async resumeSchedule(scheduleId) { ... },
 * });
 *
 * export default defineConfig({
 *   db: myAdapter,
 * });
 * ```
 */
export function createDbAdapter(impl: {
  /** A human-readable name for this adapter (for logging/debugging) */
  name: string;

  upsertSchedule(def: CronDefinition | ScheduleDefinition): Promise<void>;

  getDueSchedules(
    now: Date,
    limit: number,
    prefix?: string,
  ): Promise<Pick<CronDefinition | ScheduleDefinition, "name">[]>;

  getSchedules(
    prefix?: string,
  ): Promise<
    Array<{ name: string; lastRunAt: Date | null; nextRunAt: Date | null }>
  >;

  updateNextRun(scheduleId: string, nextRunAt: Date | null): Promise<void>;

  recordExecution(job: JobRecord): Promise<void>;

  updateJobProgress(
    id: string,
    progressPercent: number,
    progressLabel?: string,
  ): Promise<void>;

  getExecutions(
    scheduleId: string,
    opts: { limit: number; offset: number },
  ): Promise<JobRecord[]>;

  getActiveJobs(): Promise<JobRecord[]>;

  cleanOldExecutions(before: Date): Promise<number>;

  pruneHistoryForSchedule(
    scheduleId: string,
    keepJobHistory: number | boolean,
    keepFailedJobHistory: number | boolean,
  ): Promise<void>;

  pauseSchedule(scheduleId: string): Promise<void>;

  resumeSchedule(scheduleId: string): Promise<void>;
}): IOqronAdapter {
  const requiredMethods: (keyof IOqronAdapter)[] = [
    "upsertSchedule",
    "getDueSchedules",
    "getSchedules",
    "updateNextRun",
    "recordExecution",
    "updateJobProgress",
    "getExecutions",
    "getActiveJobs",
    "cleanOldExecutions",
    "pruneHistoryForSchedule",
    "pauseSchedule",
    "resumeSchedule",
  ];

  for (const method of requiredMethods) {
    if (typeof impl[method] !== "function") {
      throw new Error(
        `[OqronKit] createDbAdapter: Missing required method '${method}' in adapter '${impl.name}'. ` +
          `See IOqronAdapter interface for the full contract.`,
      );
    }
  }

  return impl;
}

/**
 * Create a custom lock adapter by providing implementations for the ILockAdapter interface.
 *
 * This factory validates that all required methods are provided and returns a typed adapter
 * that OqronKit can use directly in the config.
 *
 * @example
 * ```ts
 * import { createLockAdapter, defineConfig } from "oqronkit";
 *
 * const myLock = createLockAdapter({
 *   name: "dynamodb",
 *
 *   async acquire(key, ownerId, ttlMs) {
 *     // Use DynamoDB conditional PutItem with TTL
 *     const result = await dynamoClient.putItem({
 *       TableName: "oqron_locks",
 *       Item: { pk: key, ownerId, expiresAt: Date.now() + ttlMs },
 *       ConditionExpression: "attribute_not_exists(pk) OR expiresAt < :now",
 *       ExpressionAttributeValues: { ":now": Date.now() },
 *     });
 *     return result.$metadata.httpStatusCode === 200;
 *   },
 *
 *   async renew(key, ownerId, ttlMs) { ... },
 *   async release(key, ownerId) { ... },
 *   async isOwner(key, ownerId) { ... },
 * });
 *
 * export default defineConfig({
 *   lock: myLock,
 * });
 * ```
 */
export function createLockAdapter(impl: {
  /** A human-readable name for this adapter (for logging/debugging) */
  name: string;

  acquire(key: string, ownerId: string, ttlMs: number): Promise<boolean>;
  renew(key: string, ownerId: string, ttlMs: number): Promise<boolean>;
  release(key: string, ownerId: string): Promise<void>;
  isOwner(key: string, ownerId: string): Promise<boolean>;
}): ILockAdapter {
  const requiredMethods: (keyof ILockAdapter)[] = [
    "acquire",
    "renew",
    "release",
    "isOwner",
  ];

  for (const method of requiredMethods) {
    if (typeof impl[method] !== "function") {
      throw new Error(
        `[OqronKit] createLockAdapter: Missing required method '${method}' in adapter '${impl.name}'. ` +
          `See ILockAdapter interface for the full contract.`,
      );
    }
  }

  return impl;
}
