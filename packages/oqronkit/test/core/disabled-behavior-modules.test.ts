import { describe, expect, it } from "vitest";
import {
  cronModule,
  scheduleModule,
  queueModule,
  normalizeModules,
} from "../../src/modules.js";
import { applyModuleDefaults } from "../../src/engine/config/schema.js";

describe("Module configs — disabledBehavior & maxHeldJobs", () => {
  // ── Factory function pass-through ─────────────────────────────────────────

  it("cronModule() passes disabledBehavior through", () => {
    const def = cronModule({ disabledBehavior: "reject" });
    expect(def.module).toBe("cron");
    expect(def.disabledBehavior).toBe("reject");
  });

  it("scheduleModule() passes disabledBehavior through", () => {
    const def = scheduleModule({ disabledBehavior: "skip" });
    expect(def.module).toBe("scheduler");
    expect(def.disabledBehavior).toBe("skip");
  });

  it("queueModule() passes disabledBehavior through", () => {
    const def = queueModule({ disabledBehavior: "hold" });
    expect(def.module).toBe("queue");
    expect(def.disabledBehavior).toBe("hold");
  });

  it("cronModule() passes maxHeldJobs through", () => {
    const def = cronModule({ disabledBehavior: "hold", maxHeldJobs: 50 });
    expect(def.maxHeldJobs).toBe(50);
  });

  it("scheduleModule() passes maxHeldJobs through", () => {
    const def = scheduleModule({ maxHeldJobs: 25 });
    expect(def.maxHeldJobs).toBe(25);
  });

  it("queueModule() passes maxHeldJobs through", () => {
    const def = queueModule({ maxHeldJobs: 200 });
    expect(def.maxHeldJobs).toBe(200);
  });

  // ── Defaults (not required) ───────────────────────────────────────────────

  it("cronModule() leaves disabledBehavior undefined by default", () => {
    const def = cronModule();
    expect(def.disabledBehavior).toBeUndefined();
    expect(def.maxHeldJobs).toBeUndefined();
  });

  it("scheduleModule() leaves disabledBehavior undefined by default", () => {
    const def = scheduleModule();
    expect(def.disabledBehavior).toBeUndefined();
    expect(def.maxHeldJobs).toBeUndefined();
  });

  it("queueModule() leaves disabledBehavior undefined by default", () => {
    const def = queueModule();
    expect(def.disabledBehavior).toBeUndefined();
    expect(def.maxHeldJobs).toBeUndefined();
  });

  // ── normalizeModules preserves the values ─────────────────────────────────

  it("normalizeModules preserves disabledBehavior and maxHeldJobs", () => {
    const normalized = normalizeModules([
      cronModule({ disabledBehavior: "reject", maxHeldJobs: 10 }),
      scheduleModule({ disabledBehavior: "skip" }),
      queueModule({ disabledBehavior: "hold", maxHeldJobs: 500 }),
    ]);

    const cronDef = normalized.find((m) => m.module === "cron");
    const schedulerDef = normalized.find((m) => m.module === "scheduler");
    const queueDef = normalized.find((m) => m.module === "queue");

    expect((cronDef as any).disabledBehavior).toBe("reject");
    expect((cronDef as any).maxHeldJobs).toBe(10);
    expect((schedulerDef as any).disabledBehavior).toBe("skip");
    expect((queueDef as any).disabledBehavior).toBe("hold");
    expect((queueDef as any).maxHeldJobs).toBe(500);
  });

  // ── applyModuleDefaults does not stomp on disabledBehavior ────────────────

  it("applyModuleDefaults preserves disabledBehavior for cron", () => {
    const def = applyModuleDefaults(cronModule({ disabledBehavior: "reject" }));
    expect((def as any).disabledBehavior).toBe("reject");
  });

  it("applyModuleDefaults preserves disabledBehavior for scheduler", () => {
    const def = applyModuleDefaults(scheduleModule({ disabledBehavior: "skip" }));
    expect((def as any).disabledBehavior).toBe("skip");
  });

  it("applyModuleDefaults preserves disabledBehavior for queue", () => {
    const def = applyModuleDefaults(queueModule({ disabledBehavior: "hold" }));
    expect((def as any).disabledBehavior).toBe("hold");
  });
});
