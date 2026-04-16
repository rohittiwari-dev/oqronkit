import { randomUUID } from "node:crypto";
import type { CronDefinition, Logger } from "../engine/index.js";
import { cronParser } from "./cron-compat.js";

export interface MissedFireResult {
  missed: boolean;
  /** The specific dates that were missed. For "run-all", contains all occurrences. */
  missedDates: Date[];
}

export class MissedFireHandler {
  constructor(private readonly logger: Logger) {}

  async checkMissed(
    def: CronDefinition,
    lastRunAt: Date | null,
    now: Date,
  ): Promise<MissedFireResult> {
    const NONE: MissedFireResult = { missed: false, missedDates: [] };
    if (!lastRunAt) return NONE;

    try {
      let missed = false;
      const missedDates: Date[] = [];

      if (def.expression) {
        const opts = { currentDate: lastRunAt, tz: def.timezone };
        try {
          const interval = cronParser.parseExpression(def.expression, opts);

          if (def.missedFire === "run-all") {
            // Enumerate all missed occurrences between lastRunAt and now
            let next = interval.next().toDate();
            while (next <= now) {
              missedDates.push(next);
              try {
                next = interval.next().toDate();
              } catch {
                break; // No more occurrences
              }
            }
            missed = missedDates.length > 0;
          } else {
            // For "run-once" or "skip", just check if the previous occurrence was after lastRunAt
            const prevOpts = { currentDate: now, tz: def.timezone };
            const prevRun = cronParser
              .parseExpression(def.expression, prevOpts)
              .prev()
              .toDate();
            missed = prevRun > lastRunAt;
            if (missed) {
              missedDates.push(prevRun);
            }
          }
        } catch {
          // Cron-parser expression error — treat as not missed
          return NONE;
        }
      } else if (def.intervalMs) {
        const elapsed = now.getTime() - lastRunAt.getTime();
        missed = elapsed > def.intervalMs;

        if (missed && def.missedFire === "run-all") {
          // Enumerate all missed interval ticks
          let tickTime = new Date(lastRunAt.getTime() + def.intervalMs);
          while (tickTime <= now) {
            missedDates.push(tickTime);
            tickTime = new Date(tickTime.getTime() + def.intervalMs);
          }
        } else if (missed) {
          missedDates.push(now); // Just the latest for "run-once"
        }
      }

      if (missed) {
        this.logger.warn("Missed execution detected", {
          name: def.name,
          policy: def.missedFire,
          count: missedDates.length,
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
          return { missed: true, missedDates };
        }
      }
    } catch (err) {
      // Log unexpected runtime errors rather than silently swallowing them
      this.logger.error("MissedFireHandler encountered an unexpected error", {
        name: def.name,
        err: String(err),
      });
    }

    return { missed: false, missedDates: [] };
  }
}
