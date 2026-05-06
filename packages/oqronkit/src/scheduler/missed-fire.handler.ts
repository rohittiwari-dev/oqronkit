import { randomUUID } from "node:crypto";
import type { ICronContext } from "../engine/context/cron-context.interface.js";
import type { CronDefinition, Logger } from "../engine/index.js";
import { cronParser } from "./cron-compat.js";

/**
 * Narrow subset of CronDefinition fields used by MissedFireHandler.
 * Both CronDefinition and ScheduleDefinition satisfy this contract.
 */
type MissedFireDef = Pick<
  CronDefinition,
  | "name"
  | "expression"
  | "intervalMs"
  | "timezone"
  | "missedFire"
  | "maxMissedRuns"
  | "hooks"
>;
export interface MissedFireResult {
  missed: boolean;
  /** The specific dates that were missed. For "run-all", contains all occurrences. */
  missedDates: Date[];
}

/**  Lightweight context for missed-fire hooks — satisfies ICronContext without full engine wiring */
function createMissedFireContext(
  defName: string,
  logger: Logger,
  now: Date,
): ICronContext {
  const startedAt = Date.now();
  const childLogger = logger.child({ schedule: defName, scope: "missed-fire" });
  const signal = new AbortController().signal;
  let _progress = 0;

  return {
    id: randomUUID(),
    name: defName,
    scheduleName: defName,
    log: childLogger,
    signal,
    get aborted() {
      return signal.aborted;
    },
    firedAt: now,
    get duration() {
      return Date.now() - startedAt;
    },
    environment: undefined,
    project: undefined,
    progress(value: number, _label?: string) {
      _progress = Math.max(0, Math.min(100, value));
    },
    getProgress() {
      return _progress;
    },
  };
}

export class MissedFireHandler {
  constructor(private readonly logger: Logger) {}

  async checkMissed(
    def: MissedFireDef,
    lastRunAt: Date | null,
    now: Date,
  ): Promise<MissedFireResult> {
    const NONE: MissedFireResult = { missed: false, missedDates: [] };
    if (!lastRunAt) return NONE;

    try {
      let missed = false;
      const missedDates: Date[] = [];
      const maxMissedRuns = Math.max(1, def.maxMissedRuns ?? 100);
      let droppedMissedRuns = 0;

      if (def.expression) {
        const opts = { currentDate: lastRunAt, tz: def.timezone };
        try {
          const interval = cronParser.parseExpression(def.expression, opts);

          if (def.missedFire === "run-all") {
            // Enumerate all missed occurrences between lastRunAt and now
            let next = interval.next().toDate();
            while (next <= now) {
              if (missedDates.length < maxMissedRuns) {
                missedDates.push(next);
              } else {
                droppedMissedRuns++;
              }
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
            if (missedDates.length < maxMissedRuns) {
              missedDates.push(tickTime);
            } else {
              droppedMissedRuns++;
            }
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
          dropped: droppedMissedRuns,
        });

        if (def.hooks?.onMissedFire) {
          try {
            for (const missedAt of missedDates) {
              const ctx = createMissedFireContext(
                def.name,
                this.logger,
                missedAt,
              );
              await def.hooks.onMissedFire(ctx, missedAt);
            }
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
