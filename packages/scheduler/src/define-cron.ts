import type {
  CronDefinition,
  ICronContext,
  MissedFirePolicy,
} from "@chronoforge/core";
import * as cronParser from "cron-parser";

export interface DefineCronOptions {
  expression: string;
  timezone?: string;
  missedFirePolicy?: MissedFirePolicy;
  /** Set to false to skip execution if a previous run is still active */
  overlap?: boolean;
  tags?: string[];
}

export function cron(
  id: string,
  options: DefineCronOptions,
  handler: (ctx: ICronContext) => Promise<unknown>,
): CronDefinition {
  // Validate immediately at definition time
  try {
    cronParser.parseExpression(options.expression, { tz: options.timezone });
  } catch {
    throw new Error(
      `[ChronoForge] Invalid cron expression for "${id}": "${options.expression}"`,
    );
  }

  return {
    id,
    expression: options.expression,
    timezone: options.timezone,
    missedFirePolicy: options.missedFirePolicy ?? "skip",
    overlap: options.overlap ?? true,
    tags: options.tags ?? [],
    handler,
  };
}
