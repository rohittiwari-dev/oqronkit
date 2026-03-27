import type { CronDefinition, Logger } from "@chronoforge/core";

/**
 * Evaluates missed-fire scenarios when the scheduler restarts and detects
 * that a schedule hasn't run in a while.
 */
export class MissedFireHandler {
  constructor(private readonly _logger: Logger) {}

  async evaluate(
    schedule: CronDefinition,
    lastRunAt: Date | null,
  ): Promise<boolean> {
    if (!lastRunAt) return false;

    if (schedule.missedFire === "run-once") {
      this._logger.warn(
        `Missed execution detected for ${schedule.name}, policy: run-once`,
      );
      // Wait, we should trigger onMissedFire hook if it exists
      return true;
    }

    return false;
  }
}
