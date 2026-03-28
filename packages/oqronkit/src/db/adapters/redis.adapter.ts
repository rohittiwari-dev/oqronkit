import type { CronDefinition, JobRecord } from "../../core/types/cron.types.js";
import type { IOqronAdapter } from "../../core/types/db.types.js";
import type { ScheduleDefinition } from "../../core/types/scheduler.types.js";

/**
 * RedisAdapter — High-performance IOqronAdapter backed by Redis.
 *
 * Data model:
 * - Schedule definitions → Redis Hashes at `{prefix}:schedule:{name}`
 * - Due schedules index  → Sorted Set at `{prefix}:schedules:due` with score = nextRunAt timestamp
 * - Schedule listing     → Set at `{prefix}:schedules:all`
 * - Job executions       → Lists at `{prefix}:jobs:{scheduleId}` (newest first, capped)
 * - Active jobs index    → Hash at `{prefix}:jobs:active`
 *
 * Accepts any `ioredis`-compatible client.
 *
 * Usage:
 * ```ts
 * import Redis from "ioredis";
 * import { RedisAdapter } from "oqronkit";
 *
 * const redis = new Redis("redis://localhost:6379");
 * const adapter = new RedisAdapter(redis);
 * ```
 */
export class RedisAdapter implements IOqronAdapter {
  private readonly prefix: string;
  private readonly maxHistoryPerSchedule: number;

  constructor(
    private readonly redis: {
      hset(key: string, ...args: any[]): Promise<number>;
      hget(key: string, field: string): Promise<string | null>;
      hgetall(key: string): Promise<Record<string, string>>;
      hdel(key: string, ...fields: string[]): Promise<number>;
      sadd(key: string, ...members: string[]): Promise<number>;
      srem(key: string, ...members: string[]): Promise<number>;
      smembers(key: string): Promise<string[]>;
      zadd(key: string, ...args: any[]): Promise<number | string>;
      zrangebyscore(
        key: string,
        min: string | number,
        max: string | number,
        ...args: any[]
      ): Promise<string[]>;
      zrem(key: string, ...members: string[]): Promise<number>;
      lpush(key: string, ...values: string[]): Promise<number>;
      lrange(key: string, start: number, stop: number): Promise<string[]>;
      llen(key: string): Promise<number>;
      ltrim(key: string, start: number, stop: number): Promise<string>;
      del(...keys: string[]): Promise<number>;
      eval(...args: any[]): Promise<any>;
    },
    opts?: {
      prefix?: string;
      maxHistoryPerSchedule?: number;
    },
  ) {
    this.prefix = opts?.prefix ?? "oqron";
    this.maxHistoryPerSchedule = opts?.maxHistoryPerSchedule ?? 1000;
  }

  // ── Key builders ─────────────────────────────────────────────────────────

  private scheduleKey(name: string): string {
    return `${this.prefix}:schedule:${name}`;
  }
  private dueSetKey(): string {
    return `${this.prefix}:schedules:due`;
  }
  private allSetKey(): string {
    return `${this.prefix}:schedules:all`;
  }
  private jobsKey(scheduleId: string): string {
    return `${this.prefix}:jobs:${scheduleId}`;
  }
  private activeJobsKey(): string {
    return `${this.prefix}:jobs:active`;
  }

  // ── Schedule CRUD ────────────────────────────────────────────────────────

  async upsertSchedule(
    def: CronDefinition | ScheduleDefinition,
  ): Promise<void> {
    const key = this.scheduleKey(def.name);

    // Serialize the schedule metadata into a flat hash
    const fields: Record<string, string> = {
      name: def.name,
      status: (def as any).status ?? "active",
      tags: JSON.stringify(def.tags ?? []),
      missedFire: def.missedFire ?? "skip",
      overlap: String(def.overlap ?? "skip"),
    };

    if ("expression" in def && def.expression) {
      fields.expression = def.expression;
    }
    if ("intervalMs" in def && def.intervalMs) {
      fields.intervalMs = String(def.intervalMs);
    }
    if (def.timezone) fields.timezone = def.timezone;

    // Schedule-specific fields
    if ("runAt" in def && (def as any).runAt) {
      fields.runAt = new Date((def as any).runAt).toISOString();
    }
    if ("runAfterOpts" in def && (def as any).runAfterOpts) {
      fields.runAfterOpts = JSON.stringify((def as any).runAfterOpts);
    }
    if ("rrule" in def && (def as any).rrule) {
      fields.rrule = (def as any).rrule;
    }
    if ("recurring" in def && (def as any).recurring) {
      fields.recurring = JSON.stringify((def as any).recurring);
    }

    // Flatten into hset args: field1, value1, field2, value2, ...
    const args: string[] = [];
    for (const [k, v] of Object.entries(fields)) {
      args.push(k, v);
    }

    await this.redis.hset(key, ...args);
    await this.redis.sadd(this.allSetKey(), def.name);
  }

  async getDueSchedules(
    now: Date,
    limit: number,
    prefix?: string,
  ): Promise<Pick<CronDefinition | ScheduleDefinition, "name">[]> {
    const nowTs = now.getTime();

    // Get schedule names with score (nextRunAt) <= nowTs
    const names = await this.redis.zrangebyscore(
      this.dueSetKey(),
      0,
      nowTs,
      "LIMIT",
      0,
      limit * 2, // Fetch more than needed to filter by prefix and status
    );

    const results: { name: string }[] = [];

    for (const name of names) {
      if (results.length >= limit) break;
      if (prefix && !name.startsWith(prefix)) continue;

      // Check status
      const status = await this.redis.hget(this.scheduleKey(name), "status");
      if (status !== "active") continue;

      results.push({ name });
    }

    return results;
  }

  async getSchedules(
    prefix?: string,
  ): Promise<
    Array<{ name: string; lastRunAt: Date | null; nextRunAt: Date | null }>
  > {
    const allNames = await this.redis.smembers(this.allSetKey());
    const results: Array<{
      name: string;
      lastRunAt: Date | null;
      nextRunAt: Date | null;
    }> = [];

    for (const name of allNames) {
      if (prefix && !name.startsWith(prefix)) continue;

      const data = await this.redis.hgetall(this.scheduleKey(name));
      results.push({
        name,
        lastRunAt: data.lastRunAt ? new Date(data.lastRunAt) : null,
        nextRunAt: data.nextRunAt ? new Date(data.nextRunAt) : null,
      });
    }

    return results;
  }

  async updateNextRun(
    scheduleId: string,
    nextRunAt: Date | null,
  ): Promise<void> {
    const key = this.scheduleKey(scheduleId);

    if (nextRunAt) {
      await this.redis.hset(key, "nextRunAt", nextRunAt.toISOString());
      // Update the sorted set score for due-schedule lookup
      await this.redis.zadd(this.dueSetKey(), nextRunAt.getTime(), scheduleId);
    } else {
      await this.redis.hdel(key, "nextRunAt");
      // Remove from due set — one-shot schedule that's done
      await this.redis.zrem(this.dueSetKey(), scheduleId);
    }
  }

  // ── Job Execution History ────────────────────────────────────────────────

  async recordExecution(job: JobRecord): Promise<void> {
    const serialized = JSON.stringify({
      ...job,
      startedAt:
        job.startedAt instanceof Date
          ? job.startedAt.toISOString()
          : job.startedAt,
      completedAt:
        job.completedAt instanceof Date
          ? job.completedAt.toISOString()
          : job.completedAt,
    });

    if (job.status === "running") {
      // Track active job
      await this.redis.hset(this.activeJobsKey(), job.id, serialized);
    } else {
      // Move from active → history
      await this.redis.hdel(this.activeJobsKey(), job.id);
    }

    // Always push to history list (newest first)
    const listKey = this.jobsKey(job.scheduleId ?? "_unknown");
    await this.redis.lpush(listKey, serialized);

    // Auto-cap history to prevent unbounded growth
    await this.redis.ltrim(listKey, 0, this.maxHistoryPerSchedule - 1);

    // Update lastRunAt on the schedule
    if (job.scheduleId) {
      await this.redis.hset(
        this.scheduleKey(job.scheduleId),
        "lastRunAt",
        job.startedAt instanceof Date
          ? job.startedAt.toISOString()
          : job.startedAt,
      );
    }
  }

  async updateJobProgress(
    id: string,
    progressPercent: number,
    progressLabel?: string,
  ): Promise<void> {
    // Update the active job entry with progress info
    const raw = await this.redis.hget(this.activeJobsKey(), id);
    if (!raw) return;

    const job = JSON.parse(raw);
    job.progressPercent = progressPercent;
    if (progressLabel) job.progressLabel = progressLabel;

    await this.redis.hset(this.activeJobsKey(), id, JSON.stringify(job));
  }

  async getExecutions(
    scheduleId: string,
    opts: { limit: number; offset: number },
  ): Promise<JobRecord[]> {
    const listKey = this.jobsKey(scheduleId);
    const raw = await this.redis.lrange(
      listKey,
      opts.offset,
      opts.offset + opts.limit - 1,
    );

    return raw.map((item) => {
      const parsed = JSON.parse(item);
      return {
        ...parsed,
        startedAt: new Date(parsed.startedAt),
        completedAt: parsed.completedAt
          ? new Date(parsed.completedAt)
          : undefined,
      };
    });
  }

  async getActiveJobs(): Promise<JobRecord[]> {
    const all = await this.redis.hgetall(this.activeJobsKey());
    return Object.values(all).map((raw) => {
      const parsed = JSON.parse(raw);
      return {
        ...parsed,
        startedAt: new Date(parsed.startedAt),
        completedAt: parsed.completedAt
          ? new Date(parsed.completedAt)
          : undefined,
      };
    });
  }

  async cleanOldExecutions(before: Date): Promise<number> {
    // Redis doesn't support SQL-like date filtering on lists.
    // We iterate all schedule lists and remove old entries.
    const allNames = await this.redis.smembers(this.allSetKey());
    let totalRemoved = 0;

    for (const name of allNames) {
      const listKey = this.jobsKey(name);
      const all = await this.redis.lrange(listKey, 0, -1);

      const keep: string[] = [];
      for (const raw of all) {
        const parsed = JSON.parse(raw);
        const startedAt = new Date(parsed.startedAt);
        if (startedAt >= before) {
          keep.push(raw);
        } else {
          totalRemoved++;
        }
      }

      if (keep.length < all.length) {
        // Rebuild the list with only kept entries
        await this.redis.del(listKey);
        if (keep.length > 0) {
          // lpush in reverse order to maintain original order
          await this.redis.lpush(listKey, ...keep.reverse());
        }
      }
    }

    return totalRemoved;
  }

  async pruneHistoryForSchedule(
    scheduleId: string,
    keepJobHistory: number | boolean,
    keepFailedJobHistory: number | boolean,
  ): Promise<void> {
    const listKey = this.jobsKey(scheduleId);

    if (keepJobHistory === false) {
      // Delete all history
      await this.redis.del(listKey);
      return;
    }

    if (typeof keepJobHistory === "number") {
      // Trim to keep only the latest N entries
      await this.redis.ltrim(listKey, 0, keepJobHistory - 1);
    }

    // For keepFailedJobHistory, we can't selectively trim Redis lists
    // by field value without a full scan, so we respect the general cap.
    if (keepFailedJobHistory === false) {
      // Remove all failed entries (requires full scan + rebuild)
      const all = await this.redis.lrange(listKey, 0, -1);
      const filtered = all.filter((raw) => {
        const parsed = JSON.parse(raw);
        return parsed.status !== "failed";
      });

      if (filtered.length < all.length) {
        await this.redis.del(listKey);
        if (filtered.length > 0) {
          await this.redis.lpush(listKey, ...filtered.reverse());
        }
      }
    }
  }

  // ── Pause/Resume ─────────────────────────────────────────────────────────

  async pauseSchedule(scheduleId: string): Promise<void> {
    await this.redis.hset(this.scheduleKey(scheduleId), "status", "paused");
  }

  async resumeSchedule(scheduleId: string): Promise<void> {
    await this.redis.hset(this.scheduleKey(scheduleId), "status", "active");
  }
}
