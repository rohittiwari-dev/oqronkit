import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/engine/logger/index.js";
import type { CronDefinition } from "../../src/engine/types/cron.types.js";
import { MissedFireHandler } from "../../src/scheduler/missed-fire.handler.js";

describe("MissedFireHandler", () => {
  const logger = createLogger({ enabled: false }, { module: "missed-fire-test" });

  it("caps run-all catch-up occurrences", async () => {
    const handler = new MissedFireHandler(logger);
    const def: CronDefinition = {
      name: "bounded",
      intervalMs: 1000,
      missedFire: "run-all",
      maxMissedRuns: 3,
      handler: async () => undefined,
    };

    const result = await handler.checkMissed(
      def,
      new Date("2026-05-01T00:00:00.000Z"),
      new Date("2026-05-01T00:00:10.000Z"),
    );

    expect(result.missed).toBe(true);
    expect(result.missedDates).toHaveLength(3);
  });

  it("passes each missed occurrence to onMissedFire", async () => {
    const seen: string[] = [];
    const handler = new MissedFireHandler(logger);
    const def: CronDefinition = {
      name: "hooked",
      intervalMs: 1000,
      missedFire: "run-all",
      maxMissedRuns: 2,
      handler: async () => undefined,
      hooks: {
        onMissedFire: (_ctx, missedAt) => {
          seen.push(missedAt.toISOString());
        },
      },
    };

    await handler.checkMissed(
      def,
      new Date("2026-05-01T00:00:00.000Z"),
      new Date("2026-05-01T00:00:03.000Z"),
    );

    expect(seen).toEqual([
      "2026-05-01T00:00:01.000Z",
      "2026-05-01T00:00:02.000Z",
    ]);
  });
});
