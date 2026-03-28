import { describe, it, expect } from "vitest";
import { cron } from "../../src/scheduler/define-cron.js";

describe("cron() factory", () => {
  // ── Expression-based ──────────────────────────────────────────────────────
  it("creates a valid CronDefinition from an expression", () => {
    const def = cron({ 
      name: "my-job", 
      expression: "*/5 * * * *", 
      handler: async () => { /* noop */ } 
    });
    expect(def.name).toBe("my-job");
    expect(def.expression).toBe("*/5 * * * *");
    expect(def.intervalMs).toBeUndefined();
    expect(def.missedFire).toBe("skip");
    expect(def.overlap).toBe("skip");
    expect(def.guaranteedWorker).toBe(false);
    expect(def.tags).toEqual([]);
  });

  it("throws for an invalid cron expression", () => {
    expect(() =>
      cron({ 
        name: "bad-job", 
        expression: "bad expression", 
        handler: async () => { /* noop */ } 
      }),
    ).toThrow(/Invalid cron expression/);
  });

  it("respects all config options with expression", () => {
    const def = cron({
      name: "custom",
      expression: "0 * * * *",
      missedFire: "run-once",
      overlap: "skip",
      guaranteedWorker: true,
      heartbeatMs: 5_000,
      lockTtlMs: 20_000,
      timeout: 120_000,
      tags: ["billing"],
      handler: async () => { /* noop */ }
    });
    expect(def.missedFire).toBe("run-once");
    expect(def.overlap).toBe("skip");
    expect(def.guaranteedWorker).toBe(true);
    expect(def.heartbeatMs).toBe(5_000);
    expect(def.lockTtlMs).toBe(20_000);
    expect(def.timeout).toBe(120_000);
    expect(def.tags).toContain("billing");
  });

  // ── Interval-based (every) ────────────────────────────────────────────────
  it("creates a valid CronDefinition from an `every` config", () => {
    const def = cron({
      name: "inventory-sync",
      every: { minutes: 15 },
      overlap: "skip",
      timeout: 300_000,
      handler: async () => { /* noop */ }
    });
    expect(def.name).toBe("inventory-sync");
    expect(def.expression).toBeUndefined();
    expect(def.intervalMs).toBe(15 * 60_000);
    expect(def.overlap).toBe("skip");
    expect(def.timeout).toBe(300_000);
  });

  it("handles `every` with mixed units", () => {
    const def = cron({
      name: "mixed",
      every: { hours: 1, minutes: 30 },
      handler: async () => { /* noop */ }
    });
    expect(def.intervalMs).toBe(
      1 * 3_600_000 + 30 * 60_000
    );
  });

  it("throws when `every` resolves to zero", () => {
    expect(() =>
      cron({
        name: "empty-every",
        every: {},
        handler: async () => { /* noop */ }
      }),
    ).toThrow(/positive interval/);
  });
});
