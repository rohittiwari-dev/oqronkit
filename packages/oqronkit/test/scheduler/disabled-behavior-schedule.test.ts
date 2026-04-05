import { describe, expect, it, beforeEach } from "vitest";
import { schedule } from "../../src/scheduler/define-schedule.js";
import { _drainPendingSchedules } from "../../src/scheduler/registry-schedule.js";
import { _attachScheduleEngine } from "../../src/scheduler/define-schedule.js";

describe("schedule() factory — disabledBehavior wiring", () => {
  beforeEach(() => {
    _drainPendingSchedules();
    _attachScheduleEngine(null);
  });

  it("passes disabledBehavior='hold' through to ScheduleDefinition", () => {
    const s = schedule({
      name: "hold-sched",
      every: { minutes: 5 },
      disabledBehavior: "hold",
      handler: async () => {},
    });
    expect(s.disabledBehavior).toBe("hold");
    _drainPendingSchedules();
  });

  it("passes disabledBehavior='skip' through to ScheduleDefinition", () => {
    const s = schedule({
      name: "skip-sched",
      every: { minutes: 5 },
      disabledBehavior: "skip",
      handler: async () => {},
    });
    expect(s.disabledBehavior).toBe("skip");
    _drainPendingSchedules();
  });

  it("passes disabledBehavior='reject' through to ScheduleDefinition", () => {
    const s = schedule({
      name: "reject-sched",
      every: { minutes: 5 },
      disabledBehavior: "reject",
      handler: async () => {},
    });
    expect(s.disabledBehavior).toBe("reject");
    _drainPendingSchedules();
  });

  it("defaults to undefined when not specified (engine resolves to 'hold')", () => {
    const s = schedule({
      name: "default-sched",
      every: { minutes: 5 },
      handler: async () => {},
    });
    expect(s.disabledBehavior).toBeUndefined();
    _drainPendingSchedules();
  });
});
