import { describe, it, expect, beforeEach } from "vitest";
import {
  pruneAfterCompletion,
  keepHistoryToRemoveConfig,
} from "../../src/engine/utils/job-retention.js";
import { initEngine, Storage } from "../../src/engine/core.js";

describe("pruneAfterCompletion()", () => {
  beforeEach(async () => {
    // Re-initialize engine with memory adapters (resets all storage)
    await initEngine({} as any);
  });

  it("should keep all jobs when config is false (default)", async () => {
    await Storage.save("jobs", "j1", { id: "j1", status: "completed", finishedOn: Date.now() });

    await pruneAfterCompletion({
      namespace: "jobs",
      jobId: "j1",
      status: "completed",
      globalRemoveConfig: false,
    });

    const job = await Storage.get("jobs", "j1");
    expect(job).not.toBeNull();
  });

  it("should immediately remove when config is true", async () => {
    await Storage.save("jobs", "j1", { id: "j1", status: "completed", finishedOn: Date.now() });

    await pruneAfterCompletion({
      namespace: "jobs",
      jobId: "j1",
      status: "completed",
      globalRemoveConfig: true,
    });

    const job = await Storage.get("jobs", "j1");
    expect(job).toBeNull();
  });

  it("should keep N most recent and prune older when config is a number", async () => {
    // Create 5 completed jobs
    for (let i = 0; i < 5; i++) {
      await Storage.save("jobs", `j${i}`, {
        id: `j${i}`,
        status: "completed",
        finishedOn: Date.now() - (5 - i) * 1000, // j0 is oldest
      });
    }

    // Keep only 3 most recent
    await pruneAfterCompletion({
      namespace: "jobs",
      jobId: "j4",
      status: "completed",
      globalRemoveConfig: 3,
    });

    // The 2 oldest (j0, j1) should be pruned
    const j0 = await Storage.get("jobs", "j0");
    const j1 = await Storage.get("jobs", "j1");
    const j2 = await Storage.get("jobs", "j2");
    const j3 = await Storage.get("jobs", "j3");
    const j4 = await Storage.get("jobs", "j4");

    expect(j0).toBeNull();
    expect(j1).toBeNull();
    expect(j2).not.toBeNull();
    expect(j3).not.toBeNull();
    expect(j4).not.toBeNull();
  });

  it("should prune by age when { age } is provided", async () => {
    // Create a job that "finished" 10 seconds ago
    await Storage.save("jobs", "old", {
      id: "old",
      status: "completed",
      finishedOn: Date.now() - 10_000,
    });
    // Create a job that "finished" 1 second ago
    await Storage.save("jobs", "new", {
      id: "new",
      status: "completed",
      finishedOn: Date.now() - 1_000,
    });

    // Prune jobs older than 5 seconds
    await pruneAfterCompletion({
      namespace: "jobs",
      jobId: "new",
      status: "completed",
      globalRemoveConfig: { age: 5 },
    });

    const old = await Storage.get("jobs", "old");
    const newJ = await Storage.get("jobs", "new");

    expect(old).toBeNull();
    expect(newJ).not.toBeNull();
  });

  it("job-level config should override global config", async () => {
    await Storage.save("jobs", "j1", { id: "j1", status: "completed", finishedOn: Date.now() });

    // Global says keep all, but job says remove immediately
    await pruneAfterCompletion({
      namespace: "jobs",
      jobId: "j1",
      status: "completed",
      jobRemoveConfig: true,
      globalRemoveConfig: false,
    });

    const job = await Storage.get("jobs", "j1");
    expect(job).toBeNull();
  });
});

describe("keepHistoryToRemoveConfig()", () => {
  it("should return false (keep all) when keepHistory is true", () => {
    expect(keepHistoryToRemoveConfig(true)).toBe(false);
  });

  it("should return false (keep all) when keepHistory is undefined", () => {
    expect(keepHistoryToRemoveConfig(undefined)).toBe(false);
  });

  it("should return true (remove immediately) when keepHistory is false", () => {
    expect(keepHistoryToRemoveConfig(false)).toBe(true);
  });

  it("should return { count: N } when keepHistory is a number", () => {
    expect(keepHistoryToRemoveConfig(30)).toEqual({ count: 30 });
  });
});
