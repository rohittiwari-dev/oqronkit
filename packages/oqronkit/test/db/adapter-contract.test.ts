import { describe, it, expect, beforeEach } from "vitest";
import { MemoryOqronAdapter } from "../../src/db/adapters/memory.adapter.js";
import type { IOqronAdapter } from "../../src/core/types/db.types.js";
import type { JobRecord } from "../../src/core/types/cron.types.js";

/**
 * IOqronAdapter Contract Tests
 *
 * These tests verify that every adapter method works correctly.
 * The same test suite can be reused for SQLite, Postgres, and Redis
 * adapters by swapping the `createAdapter()` factory.
 */
function runAdapterContractTests(
  name: string,
  createAdapter: () => IOqronAdapter,
) {
  describe(`${name} — IOqronAdapter Contract`, () => {
    let adapter: IOqronAdapter;

    beforeEach(() => {
      adapter = createAdapter();
    });

    // ── upsertSchedule + getSchedules ──────────────────────────────

    it("upserts a schedule and retrieves it", async () => {
      await adapter.upsertSchedule({
        name: "test-cron",
        expression: "*/5 * * * *",
        missedFire: "skip",
        overlap: "skip",
        tags: ["billing"],
        handler: async () => {},
      });

      const schedules = await adapter.getSchedules();
      expect(schedules.length).toBe(1);
      expect(schedules[0].name).toBe("test-cron");
    });

    it("upserts same schedule twice without duplicating", async () => {
      const def = {
        name: "dedup-test",
        expression: "*/1 * * * *",
        missedFire: "skip" as const,
        overlap: "skip" as const,
        tags: [],
        handler: async () => {},
      };

      await adapter.upsertSchedule(def);
      await adapter.upsertSchedule(def);

      const schedules = await adapter.getSchedules();
      expect(schedules.length).toBe(1);
    });

    // ── updateNextRun + getDueSchedules ────────────────────────────

    it("marks a schedule as due and retrieves it", async () => {
      await adapter.upsertSchedule({
        name: "due-test",
        expression: "*/1 * * * *",
        missedFire: "skip",
        overlap: "skip",
        tags: [],
        handler: async () => {},
      });

      const past = new Date(Date.now() - 60_000);
      await adapter.updateNextRun("due-test", past);

      const due = await adapter.getDueSchedules(new Date(), 10);
      expect(due.length).toBe(1);
      expect(due[0].name).toBe("due-test");
    });

    it("does not return future schedules as due", async () => {
      await adapter.upsertSchedule({
        name: "future-test",
        expression: "*/1 * * * *",
        missedFire: "skip",
        overlap: "skip",
        tags: [],
        handler: async () => {},
      });

      const future = new Date(Date.now() + 60_000);
      await adapter.updateNextRun("future-test", future);

      const due = await adapter.getDueSchedules(new Date(), 10);
      expect(due.length).toBe(0);
    });

    it("updateNextRun(null) removes from due set", async () => {
      await adapter.upsertSchedule({
        name: "null-next",
        expression: "*/1 * * * *",
        missedFire: "skip",
        overlap: "skip",
        tags: [],
        handler: async () => {},
      });

      await adapter.updateNextRun("null-next", new Date(Date.now() - 1000));
      await adapter.updateNextRun("null-next", null);

      const due = await adapter.getDueSchedules(new Date(), 10);
      expect(due.length).toBe(0);
    });

    // ── recordExecution + getExecutions ────────────────────────────

    it("records an execution and retrieves it", async () => {
      await adapter.upsertSchedule({
        name: "exec-test",
        expression: "*/1 * * * *",
        missedFire: "skip",
        overlap: "skip",
        tags: [],
        handler: async () => {},
      });

      const job: JobRecord = {
        id: "job-1",
        scheduleId: "exec-test",
        status: "completed",
        startedAt: new Date(),
        completedAt: new Date(),
        attempts: 1,
      };

      await adapter.recordExecution(job);
      const execs = await adapter.getExecutions("exec-test", {
        limit: 10,
        offset: 0,
      });

      expect(execs.length).toBe(1);
      expect(execs[0].id).toBe("job-1");
      expect(execs[0].status).toBe("completed");
    });

    // ── getActiveJobs ─────────────────────────────────────────────

    it("tracks active jobs", async () => {
      await adapter.upsertSchedule({
        name: "active-test",
        expression: "*/1 * * * *",
        missedFire: "skip",
        overlap: "skip",
        tags: [],
        handler: async () => {},
      });

      await adapter.recordExecution({
        id: "active-1",
        scheduleId: "active-test",
        status: "running",
        startedAt: new Date(),
      });

      const active = await adapter.getActiveJobs();
      expect(active.length).toBeGreaterThanOrEqual(1);
      expect(active.some((j) => j.id === "active-1")).toBe(true);

      // Complete it
      await adapter.recordExecution({
        id: "active-1",
        scheduleId: "active-test",
        status: "completed",
        startedAt: new Date(),
        completedAt: new Date(),
      });

      const afterComplete = await adapter.getActiveJobs();
      expect(afterComplete.some((j) => j.id === "active-1")).toBe(false);
    });

    // ── updateJobProgress ─────────────────────────────────────────

    it("updates job progress", async () => {
      await adapter.upsertSchedule({
        name: "progress-test",
        expression: "*/1 * * * *",
        missedFire: "skip",
        overlap: "skip",
        tags: [],
        handler: async () => {},
      });

      await adapter.recordExecution({
        id: "prog-1",
        scheduleId: "progress-test",
        status: "running",
        startedAt: new Date(),
      });

      await adapter.updateJobProgress("prog-1", 75, "Processing...");

      const execs = await adapter.getExecutions("progress-test", {
        limit: 10,
        offset: 0,
      });
      const job = execs.find((j) => j.id === "prog-1");
      expect(job?.progressPercent).toBe(75);
    });

    // ── pause/resume ──────────────────────────────────────────────

    it("paused schedules are excluded from getDueSchedules", async () => {
      await adapter.upsertSchedule({
        name: "pause-test",
        expression: "*/1 * * * *",
        missedFire: "skip",
        overlap: "skip",
        tags: [],
        handler: async () => {},
      });

      await adapter.updateNextRun("pause-test", new Date(Date.now() - 1000));
      await adapter.pauseSchedule("pause-test");

      const due = await adapter.getDueSchedules(new Date(), 10);
      expect(due.some((d) => d.name === "pause-test")).toBe(false);
    });

    it("resumed schedules appear in getDueSchedules again", async () => {
      await adapter.upsertSchedule({
        name: "resume-test",
        expression: "*/1 * * * *",
        missedFire: "skip",
        overlap: "skip",
        tags: [],
        handler: async () => {},
      });

      await adapter.updateNextRun("resume-test", new Date(Date.now() - 1000));
      await adapter.pauseSchedule("resume-test");
      await adapter.resumeSchedule("resume-test");

      const due = await adapter.getDueSchedules(new Date(), 10);
      expect(due.some((d) => d.name === "resume-test")).toBe(true);
    });

    // ── cleanOldExecutions ────────────────────────────────────────

    it("cleans old executions before a date", async () => {
      await adapter.upsertSchedule({
        name: "clean-test",
        expression: "*/1 * * * *",
        missedFire: "skip",
        overlap: "skip",
        tags: [],
        handler: async () => {},
      });

      await adapter.recordExecution({
        id: "old-job",
        scheduleId: "clean-test",
        status: "completed",
        startedAt: new Date("2020-01-01"),
        completedAt: new Date("2020-01-01"),
      });

      const removed = await adapter.cleanOldExecutions(new Date("2023-01-01"));
      expect(removed).toBeGreaterThanOrEqual(1);

      const execs = await adapter.getExecutions("clean-test", {
        limit: 10,
        offset: 0,
      });
      expect(execs.some((j) => j.id === "old-job")).toBe(false);
    });
  });
}

// Run against MemoryAdapter
runAdapterContractTests("MemoryAdapter", () => new MemoryOqronAdapter());
