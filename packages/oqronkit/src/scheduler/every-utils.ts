import type { EveryConfig } from "../engine/types/cron.types.js";

const EVERY_MULTIPLIERS: Record<keyof EveryConfig, number> = {
  weeks: 604_800_000,
  days: 86_400_000,
  hours: 3_600_000,
  minutes: 60_000,
  seconds: 1_000,
};

export function everyToIntervalMs(every: EveryConfig): number {
  let ms = 0;

  for (const field of Object.keys(EVERY_MULTIPLIERS) as Array<
    keyof EveryConfig
  >) {
    const value = every[field];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(
        "[OqronKit] `every` values must be finite non-negative numbers",
      );
    }
    ms += value * EVERY_MULTIPLIERS[field];
  }

  if (ms <= 0) {
    throw new Error(
      "[OqronKit] `every` config must resolve to a positive interval",
    );
  }

  return ms;
}

export function validateEvery(every: EveryConfig | undefined): void {
  if (!every) return;
  everyToIntervalMs(every);
}
