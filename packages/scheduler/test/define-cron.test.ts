import { describe, it, expect } from "vitest";
import { cron } from "../src/define-cron.js";

describe("cron() factory", () => {
  it("creates a valid CronDefinition with defaults", () => {
    const def = cron.create({ 
      name: "my-job", 
      schedule: "*/5 * * * *", 
      handler: async () => { /* noop */ } 
    });
    
    expect(def.name).toBe("my-job");
    expect(def.schedule).toBe("*/5 * * * *");
    expect(def.missedFire).toBe("skip");
    expect(def.overlap).toBe("skip");
    expect(def.tags).toEqual([]);
  });

  it("throws for an invalid cron expression", () => {
    expect(() =>
      cron.create({ 
        name: "bad-job", 
        schedule: "bad expression", 
        handler: async () => { /* noop */ } 
      }),
    ).toThrow(/Invalid cron expression/);
  });

  it("respects custom options", () => {
    const def = cron.create({
      name: "custom",
      schedule: "0 * * * *",
      missedFire: "run-once",
      overlap: "skip",
      tags: ["billing"],
      handler: async () => { /* noop */ }
    });
    
    expect(def.missedFire).toBe("run-once");
    expect(def.overlap).toBe("skip");
    expect(def.tags).toContain("billing");
  });
});
