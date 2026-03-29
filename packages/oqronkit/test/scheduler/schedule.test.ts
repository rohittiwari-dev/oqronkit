import { describe, it, expect, beforeEach, vi } from "vitest";
import { initEngine, Storage } from "../../src/engine/core.js";
import { schedule } from "../../src/scheduler/define-schedule.js";
import {
  _registerSchedule,
  _drainPendingSchedules,
} from "../../src/scheduler/registry-schedule.js";
import { _attachScheduleEngine } from "../../src/scheduler/define-schedule.js";
import type { ScheduleDefinition } from "../../src/engine/index.js";

const config = { project: "test", environment: "test" };

describe("Schedule — defineSchedule()", () => {
  beforeEach(async () => {
    await initEngine(config);
    // Drain any pending registrations from other tests
    _drainPendingSchedules();
  });

  it("registers a schedule definition in the global registry", () => {
    schedule({
      name: "test-sched",
      every: { minutes: 5 },
      handler: async () => {},
    });

    const pending = _drainPendingSchedules();
    expect(pending).toHaveLength(1);
    expect(pending[0].name).toBe("test-sched");
  });

  it("sets default missedFire and overlap policies", () => {
    schedule({
      name: "defaults-sched",
      runAfter: { hours: 1 },
      handler: async () => {},
    });

    const pending = _drainPendingSchedules();
    expect(pending[0].missedFire).toBe("skip");
    expect(pending[0].overlap).toBe("skip");
  });

  it("sets guaranteedWorker to false by default", () => {
    schedule({
      name: "gw-sched",
      every: { seconds: 30 },
      handler: async () => {},
    });

    const pending = _drainPendingSchedules();
    expect(pending[0].guaranteedWorker).toBe(false);
  });

  it("preserves custom missedFire/overlap overrides", () => {
    schedule({
      name: "custom-sched",
      every: { minutes: 10 },
      missedFire: "run-all",
      overlap: "allow",
      handler: async () => {},
    });

    const pending = _drainPendingSchedules();
    expect(pending[0].missedFire).toBe("run-all");
    expect(pending[0].overlap).toBe("allow");
  });

  it("includes tags, payload, retries in the definition", () => {
    schedule({
      name: "rich-sched",
      every: { hours: 1 },
      tags: ["billing", "nightly"],
      payload: { reportId: 42 },
      retries: { max: 5, strategy: "fixed", baseDelay: 1000 },
      handler: async () => {},
    });

    const pending = _drainPendingSchedules();
    expect(pending[0].tags).toEqual(["billing", "nightly"]);
    expect(pending[0].payload).toEqual({ reportId: 42 });
    expect(pending[0].retries?.max).toBe(5);
  });
});

describe("Schedule — trigger()/schedule() without engine", () => {
  beforeEach(() => {
    _drainPendingSchedules();
    _attachScheduleEngine(null);
  });

  it("trigger() throws when engine is not running", async () => {
    const s = schedule({
      name: "throw-test",
      every: { minutes: 1 },
      handler: async () => {},
    });
    _drainPendingSchedules();

    await expect(s.trigger()).rejects.toThrow(
      "ScheduleEngine is not running",
    );
  });

  it("schedule() throws when engine is not running", async () => {
    const s = schedule({
      name: "throw-test-2",
      every: { minutes: 1 },
      handler: async () => {},
    });
    _drainPendingSchedules();

    await expect(s.schedule()).rejects.toThrow(
      "ScheduleEngine is not running",
    );
  });
});

describe("Schedule — trigger()/schedule() with mock engine", () => {
  const mockEngine = {
    registerDynamic: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    _drainPendingSchedules();
    _attachScheduleEngine(mockEngine);
    mockEngine.registerDynamic.mockClear();
    mockEngine.cancel.mockClear();
  });

  it("trigger() calls engine.registerDynamic with immediate runAt", async () => {
    const s = schedule({
      name: "trigger-ok",
      every: { minutes: 5 },
      handler: async () => {},
    });
    _drainPendingSchedules();

    await s.trigger();
    expect(mockEngine.registerDynamic).toHaveBeenCalledTimes(1);

    const arg = mockEngine.registerDynamic.mock.calls[0][0];
    expect(arg.name).toBe("trigger-ok");
    // runAt should be set to now (immediate fire)
    expect(arg.runAt).toBeDefined();
    expect(arg.runAt instanceof Date).toBe(true);
  });

  it("trigger() with nameSuffix creates a unique name", async () => {
    const s = schedule({
      name: "base-sched",
      every: { minutes: 5 },
      handler: async () => {},
    });
    _drainPendingSchedules();

    await s.trigger({ nameSuffix: "user-42" });
    const arg = mockEngine.registerDynamic.mock.calls[0][0];
    expect(arg.name).toBe("base-sched:user-42");
  });

  it("trigger() with runAt uses provided date (no auto-now)", async () => {
    const future = new Date(Date.now() + 60_000);
    const s = schedule({
      name: "future-sched",
      handler: async () => {},
    });
    _drainPendingSchedules();

    await s.trigger({ runAt: future });
    const arg = mockEngine.registerDynamic.mock.calls[0][0];
    expect(arg.runAt).toBe(future);
  });

  it("schedule() calls engine.registerDynamic with overrides", async () => {
    const s = schedule({
      name: "schedule-ok",
      handler: async () => {},
    });
    _drainPendingSchedules();

    await s.schedule({
      every: { hours: 2 },
      payload: { key: "value" },
    });

    expect(mockEngine.registerDynamic).toHaveBeenCalledTimes(1);
    const arg = mockEngine.registerDynamic.mock.calls[0][0];
    expect(arg.every).toEqual({ hours: 2 });
    expect(arg.payload).toEqual({ key: "value" });
  });

  it("cancel() calls engine.cancel with definition name", async () => {
    const s = schedule({
      name: "cancel-sched",
      every: { minutes: 1 },
      handler: async () => {},
    });
    _drainPendingSchedules();

    await s.cancel();
    expect(mockEngine.cancel).toHaveBeenCalledWith("cancel-sched");
  });
});

describe("Schedule Registry", () => {
  beforeEach(() => {
    _drainPendingSchedules();
  });

  it("_drainPendingSchedules returns and clears all pending", () => {
    _registerSchedule({
      name: "s1",
      handler: async () => {},
    } as ScheduleDefinition);
    _registerSchedule({
      name: "s2",
      handler: async () => {},
    } as ScheduleDefinition);

    const drained = _drainPendingSchedules();
    expect(drained).toHaveLength(2);

    // Second drain should be empty
    const drained2 = _drainPendingSchedules();
    expect(drained2).toHaveLength(0);
  });
});
