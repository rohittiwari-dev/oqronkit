import { randomUUID } from "node:crypto";
import type { CronDefinition, IChronoAdapter, Logger } from "@chronoforge/core";
import _cronParser from "cron-parser";

const cronParser = (_cronParser as any).default ?? _cronParser;

export class MissedFireHandler {
  constructor(
    private readonly logger: Logger,
    readonly _db: IChronoAdapter,
  ) {}

  async checkMissed(
    def: CronDefinition,
    lastRunAt: Date | null,
    now: Date,
  ): Promise<boolean> {
    if (!lastRunAt) return false;

    try {
      let missed = false;

      if (def.expression) {
        // Find what the PREVIOUS scheduled run should have been
        const opts = { currentDate: now, tz: def.timezone };
        const prevRun = cronParser
          .parseExpression(def.expression, opts)
          .prev()
          .toDate();

        // If the prev schedule is after lastRunAt, we missed it
        missed = prevRun > lastRunAt;
      } else if (def.intervalMs) {
        // For interval schedules: check if more than intervalMs has passed since last run
        const elapsed = now.getTime() - lastRunAt.getTime();
        missed = elapsed > def.intervalMs;
      }

      if (missed) {
        this.logger.warn("Missed execution detected", {
          name: def.name,
          policy: def.missedFire,
        });

        // Trigger user hook regardless of policy
        if (def.hooks?.onMissedFire) {
          try {
            const ctx = {
              id: randomUUID(),
              log: this.logger.child({
                schedule: def.name,
                scope: "missed-fire",
              }),
              logger: this.logger.child({
                schedule: def.name,
                scope: "missed-fire",
              }),
              signal: new AbortController().signal,
              firedAt: now,
              scheduleName: def.name,
              progress: () => {},
            } as any;
            await def.hooks.onMissedFire(ctx, lastRunAt);
          } catch (err) {
            this.logger.error("onMissedFire hook threw", {
              name: def.name,
              err: String(err),
            });
          }
        }

        if (def.missedFire === "run-once" || def.missedFire === "run-all") {
          return true;
        }
      }
    } catch {
      // Ignore parse errors (validated on startup anyway)
    }

    return false;
  }
}
