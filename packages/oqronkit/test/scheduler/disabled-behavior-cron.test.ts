import { describe, expect, it, beforeEach, vi } from "vitest";
import { cron } from "../../src/scheduler/define-cron.js";
import { _drainPending } from "../../src/scheduler/registry.js";

describe("cron() factory — disabledBehavior wiring", () => {
  beforeEach(() => {
    _drainPending();
  });

  it("passes disabledBehavior through to CronDefinition", () => {
    const def = cron({
      name: "hold-cron",
      expression: "*/5 * * * *",
      disabledBehavior: "hold",
      handler: async () => {},
    });
    expect(def.disabledBehavior).toBe("hold");
  });

  it("passes skip disabledBehavior through", () => {
    const def = cron({
      name: "skip-cron",
      expression: "*/5 * * * *",
      disabledBehavior: "skip",
      handler: async () => {},
    });
    expect(def.disabledBehavior).toBe("skip");
  });

  it("passes reject disabledBehavior through", () => {
    const def = cron({
      name: "reject-cron",
      expression: "*/5 * * * *",
      disabledBehavior: "reject",
      handler: async () => {},
    });
    expect(def.disabledBehavior).toBe("reject");
  });

  it("defaults to undefined when not specified (engine uses 'hold')", () => {
    const def = cron({
      name: "default-cron",
      expression: "*/5 * * * *",
      handler: async () => {},
    });
    expect(def.disabledBehavior).toBeUndefined();
  });
});
