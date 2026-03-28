import type {
  CronDefinition,
  CronHooks,
  EveryConfig,
  ICronContext,
  MissedFirePolicy,
  OverlapPolicy,
} from "@chronoforge/core";
import _cronParser from "cron-parser";

const cronParser = (_cronParser as any).default ?? _cronParser;

import { _registerCron } from "./registry.js";

// ── Discriminated union: user provides EITHER expression OR every, never both ──
type CronScheduleConfig =
  | { expression: string; every?: never }
  | { every: EveryConfig; expression?: never };

export type DefineCronOptions = CronScheduleConfig & {
  name: string;
  timezone?: string;
  missedFire?: MissedFirePolicy;
  overlap?: OverlapPolicy;
  guaranteedWorker?: boolean;
  heartbeatMs?: number;
  lockTtlMs?: number;
  timeout?: number;
  tags?: string[];
  handler: (ctx: ICronContext) => Promise<unknown>;
  hooks?: CronHooks;
};

// ── Helpers ─────────────────────────────────────────────────────────────────────

function everyToIntervalMs(every: EveryConfig): number {
  let ms = 0;
  if (every.seconds) ms += every.seconds * 1_000;
  if (every.minutes) ms += every.minutes * 60_000;
  if (every.hours) ms += every.hours * 3_600_000;
  if (ms <= 0)
    throw new Error(
      "[ChronoForge] `every` config must resolve to a positive interval",
    );
  return ms;
}

// ── Factory ─────────────────────────────────────────────────────────────────────

/**
 * Define a cron job. Automatically registers it with ChronoForge
 * so that `ChronoForge.init()` discovers it without manual wiring.
 *
 * @example
 * // Expression-based
 * cron({ name: 'billing', expression: '0 0 1 * *', handler: ... })
 *
 * // Interval-based
 * cron({ name: 'sync', every: { minutes: 15 }, handler: ... })
 */
export const cron = (options: DefineCronOptions): CronDefinition => {
  let expression: string | undefined;
  let intervalMs: number | undefined;

  if ("expression" in options && options.expression) {
    // Validate the cron expression immediately at definition time
    try {
      cronParser.parseExpression(options.expression, { tz: options.timezone });
    } catch {
      throw new Error(
        `[ChronoForge] Invalid cron expression for "${options.name}": "${options.expression}"`,
      );
    }
    expression = options.expression;
  } else if ("every" in options && options.every) {
    intervalMs = everyToIntervalMs(options.every);
  } else {
    throw new Error(
      `[ChronoForge] Cron "${options.name}" must specify either "expression" or "every"`,
    );
  }

  const def: CronDefinition = {
    name: options.name,
    expression,
    intervalMs,
    timezone: options.timezone,
    missedFire: options.missedFire ?? "skip",
    overlap: options.overlap ?? "skip",
    guaranteedWorker: options.guaranteedWorker ?? false,
    heartbeatMs: options.heartbeatMs,
    lockTtlMs: options.lockTtlMs,
    timeout: options.timeout,
    tags: options.tags ?? [],
    handler: options.handler,
    hooks: options.hooks,
  };

  // Auto-register: no need for manual array wiring
  _registerCron(def);

  return def;
};
