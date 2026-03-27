import type { ICronContext } from "../context/cron-context.interface.js";
export type MissedFirePolicy = "skip" | "run-once" | "run-all";
export interface CronDefinition {
  id: string;
  expression: string;
  timezone?: string;
  missedFirePolicy: MissedFirePolicy;
  overlap: boolean;
  tags: string[];
  handler: (ctx: ICronContext) => Promise<unknown>;
}
export interface JobRecord {
  id: string;
  scheduleId?: string;
  status: "running" | "completed" | "failed" | "missed" | "dead";
  startedAt: Date;
  completedAt?: Date;
  error?: string;
}
//# sourceMappingURL=cron.types.d.ts.map
