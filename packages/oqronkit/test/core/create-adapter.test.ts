import { describe, it, expect } from "vitest";
import { createDbAdapter, createLockAdapter } from "../../src/core/create-adapter.js";

describe("createDbAdapter", () => {
  const validImpl = {
    name: "test-adapter",
    upsertSchedule: async () => {},
    getDueSchedules: async () => [],
    getSchedules: async () => [],
    updateNextRun: async () => {},
    recordExecution: async () => {},
    updateJobProgress: async () => {},
    getExecutions: async () => [],
    getActiveJobs: async () => [],
    cleanOldExecutions: async () => 0,
    pruneHistoryForSchedule: async () => {},
    pauseSchedule: async () => {},
    resumeSchedule: async () => {},
  };

  it("returns a valid IOqronAdapter", () => {
    const adapter = createDbAdapter(validImpl);
    expect(adapter).toBeDefined();
    expect(typeof adapter.upsertSchedule).toBe("function");
    expect(typeof adapter.getDueSchedules).toBe("function");
    expect(typeof adapter.pauseSchedule).toBe("function");
  });

  it("throws if a required method is missing", () => {
    const broken = { ...validImpl } as any;
    delete broken.pauseSchedule;

    expect(() => createDbAdapter(broken)).toThrowError(
      /Missing required method 'pauseSchedule'/,
    );
  });
});

describe("createLockAdapter", () => {
  const validImpl = {
    name: "test-lock",
    acquire: async () => true,
    renew: async () => true,
    release: async () => {},
    isOwner: async () => true,
  };

  it("returns a valid ILockAdapter", () => {
    const lock = createLockAdapter(validImpl);
    expect(lock).toBeDefined();
    expect(typeof lock.acquire).toBe("function");
  });

  it("throws if a required method is missing", () => {
    const broken = { ...validImpl } as any;
    delete broken.release;

    expect(() => createLockAdapter(broken)).toThrowError(
      /Missing required method 'release'/,
    );
  });
});
