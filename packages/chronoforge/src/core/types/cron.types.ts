import type { ICronContext } from "../context/cron-context.interface.js";

export type MissedFirePolicy = "skip" | "run-once" | "run-all";
export type OverlapPolicy = "skip" | "run" | boolean;

export interface EveryConfig {
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
  onError?: (ctx: ICronContext, error: Error) => Promise<void> | void;
  onMissedFire?: (ctx: ICronContext, missedAt: Date) => Promise<void> | void;
}

export interface CronDefinition {
  name: string;
  expression?: string; // cron expression  (mutually exclusive with intervalMs)
  intervalMs?: number; // interval in ms   (resolved from `every` config)
  timezone?: string;
  missedFire: MissedFirePolicy;
  overlap: OverlapPolicy;
  guaranteedWorker?: boolean;
  heartbeatMs?: number;
  lockTtlMs?: number;
  timeout?: number; // handler timeout in ms
  tags: string[];
  /** Override global history rolling. `true` = infinite, `false` = none, `number` = max retained jobs. */
  keepHistory?: boolean | number;
  /** Keep specific bounded history length for failed jobs overriding general logic */
  keepFailedHistory?: boolean | number;
  handler: (ctx: ICronContext) => Promise<unknown>;
  hooks?: CronHooks;
  retries?: RetryConfig;
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
}
