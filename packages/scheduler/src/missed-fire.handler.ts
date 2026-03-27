import type { ChronoLogger, CronDefinition } from "@chronoforge/core";

/**
 * Evaluates missed-fire scenarios when the scheduler restarts and detects
 * that a schedule hasn't run in a while.
 */
export class MissedFireHandler {
  constructor(private readonly _logger: ChronoLogger) {}

  async evaluate(
    schedule: CronDefinition,
    lastRunAt: Date | null,
  ): Promise<boolean> {
    if (!lastRunAt) return false;

    if (schedule.missedFirePolicy === "run-once") {
      this._logger.warn(
        `Missed execution detected for ${schedule.id}, policy: run-once`,
      );
      return true;
    }

    return false;
  }
}
