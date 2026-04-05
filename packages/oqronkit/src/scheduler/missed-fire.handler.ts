import { randomUUID } from "node:crypto";
import _cronParser from "cron-parser";
import type { CronDefinition, Logger } from "../engine/index.js";

const cronParser = (_cronParser as any).default ?? _cronParser;

export class MissedFireHandler {
  constructor(private readonly logger: Logger) {}

  async checkMissed(
    def: CronDefinition,
    lastRunAt: Date | null,
    now: Date,
  ): Promise<boolean> {
    if (!lastRunAt) return false;

    try {
      let missed = false;

      if (def.expression) {
        const opts = { currentDate: now, tz: def.timezone };
        const prevRun = cronParser
          .parseExpression(def.expression, opts)
          .prev()
          .toDate();

        missed = prevRun > lastRunAt;
      } else if (def.intervalMs) {
        const elapsed = now.getTime() - lastRunAt.getTime();
        missed = elapsed > def.intervalMs;
      }

      if (missed) {
        this.logger.warn("Missed execution detected", {
          name: def.name,
          policy: def.missedFire,
        });

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
      // Ignore parse errors
    }

    return false;
  }
}
