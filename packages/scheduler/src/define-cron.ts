import type {
  CronDefinition,
  CronHooks,
  ICronContext,
  MissedFirePolicy,
  OverlapPolicy,
} from "@chronoforge/core";
import * as cronParser from "cron-parser";
import { _registerCron } from "./registry.js";

export interface DefineCronOptions {
  name: string;
  schedule: string;
  timezone?: string;
  missedFire?: MissedFirePolicy;
  overlap?: OverlapPolicy;
  guaranteedWorker?: boolean;
  heartbeatMs?: number;
  lockTtlMs?: number;
  tags?: string[];
  handler: (ctx: ICronContext) => Promise<unknown>;
  hooks?: CronHooks;
}

/**
 * Define a cron job. Automatically registers it with ChronoForge
 * so that `ChronoForge.init()` discovers it without manual wiring.
 */
export const cron = {
  create: (options: DefineCronOptions): CronDefinition => {
    // Validate immediately at definition time
    try {
      cronParser.parseExpression(options.schedule, { tz: options.timezone });
    } catch {
      throw new Error(
        `[ChronoForge] Invalid cron expression for "${options.name}": "${options.schedule}"`,
      );
    }

    const def: CronDefinition = {
      name: options.name,
      schedule: options.schedule,
      timezone: options.timezone,
      missedFire: options.missedFire ?? "skip",
      overlap: options.overlap ?? "skip",
      guaranteedWorker: options.guaranteedWorker ?? false,
      heartbeatMs: options.heartbeatMs,
      lockTtlMs: options.lockTtlMs,
      tags: options.tags ?? [],
      handler: options.handler,
      hooks: options.hooks,
    };

    // Auto-register: no need for manual array wiring
    _registerCron(def);

    return def;
  },
};
