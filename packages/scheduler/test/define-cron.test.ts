import { describe, it, expect } from "vitest";
import { cron } from "../src/define-cron.js";

describe("cron() factory", () => {
  it("creates a valid CronDefinition with defaults", () => {
    const def = cron("my-job", { expression: "*/5 * * * *" }, async () => { /* noop */ });
    expect(def.id).toBe("my-job");
    expect(def.expression).toBe("*/5 * * * *");
    expect(def.missedFirePolicy).toBe("skip");
    expect(def.overlap).toBe(true);
    expect(def.tags).toEqual([]);
  });

  it("throws for an invalid cron expression", () => {
    expect(() =>
      cron("bad-job", { expression: "bad expression" }, async () => { /* noop */ }),
    ).toThrow(/Invalid cron expression/);
  });

  it("respects custom options", () => {
    const def = cron(
      "custom",
      { expression: "0 * * * *", missedFirePolicy: "run-once", overlap: false, tags: ["billing"] },
      async () => { /* noop */ },
    );
    expect(def.missedFirePolicy).toBe("run-once");
    expect(def.overlap).toBe(false);
    expect(def.tags).toContain("billing");
  });
});
