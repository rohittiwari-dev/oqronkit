import type { ICronContext } from "../context/cron-context.interface.js";

export type MissedFirePolicy = "skip" | "run-once" | "run-all";
export type OverlapPolicy = "skip" | "run" | boolean;

export interface EveryConfig {
  seconds?: number;
  minutes?: number;
  hours?: number;
}

export interface CronHooks {
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
  handler: (ctx: ICronContext) => Promise<unknown>;
  hooks?: CronHooks;
}

export interface JobRecord {
  id: string;
  scheduleId?: string;
  status: "running" | "completed" | "failed" | "missed" | "dead";
  startedAt: Date;
  completedAt?: Date;
  error?: string;
}
