import type { ICronContext } from "../context/cron-context.interface.js";
import type { DisabledBehavior } from "./config.types.js";

export type MissedFirePolicy = "skip" | "run-once" | "run-all";
export type OverlapPolicy = "skip" | "run" | boolean;

export interface EveryConfig {
  weeks?: number;
  days?: number;
  seconds?: number;
  minutes?: number;
  hours?: number;
}

export interface RetryConfig {
  max: number;
  strategy: "exponential" | "fixed";
  baseDelay: number;
}

export interface CronHooks {
  beforeRun?: (ctx: ICronContext) => Promise<void> | void;
  afterRun?: (ctx: ICronContext, result: unknown) => Promise<void> | void;
  onError?: (ctx: ICronContext, error: Error) => Promise<boolean | void> | boolean | void;
  onMissedFire?: (ctx: ICronContext, missedAt: Date) => Promise<void> | void;
}

export interface CronDefinition {
  name: string;
  /** Schema version — bump when changing cron config to trigger a controlled migration. */
  version?: number;
  expression?: string; // cron expression  (mutually exclusive with intervalMs)
  intervalMs?: number; // interval in ms   (resolved from `every` config)
  timezone?: string;
  missedFire?: MissedFirePolicy;
  overlap?: OverlapPolicy;
  guaranteedWorker?: boolean;
  heartbeatMs?: number;
  lockTtlMs?: number;
  timeout?: number; // handler timeout in ms
  tags?: string[];
  /** Override global history rolling. `true` = infinite, `false` = none, `number` = max retained jobs. */
  keepHistory?: boolean | number;
  /** Keep specific bounded history length for failed jobs overriding general logic */
  keepFailedHistory?: boolean | number;
  handler: (ctx: ICronContext) => Promise<unknown>;
  hooks?: CronHooks;
  retries?: RetryConfig;
  status?: "active" | "paused";
  maxConcurrent?: number;
  /**
   * Behavior when this cron fires while disabled/paused.
   * Overrides the module-level `disabledBehavior` if set.
   * @default "hold"
   */
  disabledBehavior?: DisabledBehavior;
  /**  Execution priority when multiple schedules fire simultaneously. Lower = higher priority. Default: 0. */
  priority?: number;
  /**  Random jitter in ms added to nextRunAt to prevent thundering herd. Default: 0. */
  jitterMs?: number;
  /**  Optional rate limiter. If check() returns { allowed: false }, fire is skipped. */
  rateLimiter?: { check(ctx: any): Promise<{ allowed: boolean }> };
}

export interface JobRecord {
  id: string;
  scheduleId?: string;
  status: "running" | "completed" | "failed" | "missed" | "dead";
  startedAt: Date;
  completedAt?: Date;
  error?: string;
  result?: string;
  progressPercent?: number;
  progressLabel?: string;
  attempts?: number;
  durationMs?: number;
  tags?: string[];
}
