import type { ICronContext } from "../context/cron-context.interface.js";

export type MissedFirePolicy = "skip" | "run-once" | "run-all";
export type OverlapPolicy = "skip" | "run" | boolean;

export interface CronHooks {
  onMissedFire?: (ctx: ICronContext, missedAt: Date) => Promise<void> | void;
}

export interface CronDefinition {
  name: string;
  schedule: string;
  timezone?: string;
  missedFire: MissedFirePolicy;
  overlap: OverlapPolicy;
  guaranteedWorker?: boolean;
  heartbeatMs?: number;
  lockTtlMs?: number;
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
