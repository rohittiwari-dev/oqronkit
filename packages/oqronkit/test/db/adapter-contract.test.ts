import { describe, it, expect, beforeEach } from "vitest";
import { MemoryAdapter } from "../../src/adapters/memory.adapter.js";
import type { IOqronAdapter } from "../../src/core/types/db.types.js";
import type { OqronJob } from "../../src/core/types/job.types.js";

/**
 * IOqronAdapter Contract Tests
 *
 * Verifies that every DB adapter implementation follows the unified storage model.
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

    describe("Schedule Management", () => {
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
        expect(schedules[0].id).toBe("test-cron");
      });

      it("handles pause/resume states", async () => {
        await adapter.upsertSchedule({ name: "p-1", missedFire: "skip", overlap: "skip", tags: [], handler: async () => {} });
        await adapter.setSchedulePaused("p-1", true);
        
        const sched = await adapter.getSchedule("p-1");
        expect(sched?.status).toBe("paused");
      });
    });

    describe("Job Operations", () => {
      it("upserts and retrieves a job", async () => {
        const job: OqronJob = {
          id: "job-1",
          type: "task",
          queueName: "q1",
          status: "waiting",
          data: { foo: "bar" },
          opts: {},
          attemptMade: 0,
          progressPercent: 0,
          tags: ["t1"],
          createdAt: new Date(),
        };

        await adapter.upsertJob(job);
        const fetched = await adapter.getJob("job-1");
        expect(fetched?.id).toBe("job-1");
        expect(fetched?.data).toEqual({ foo: "bar" });
      });

      it("filters jobs correctly", async () => {
        const base = { type: "task" as const, queueName: "q", opts: {}, attemptMade: 0, progressPercent: 0, tags: [], createdAt: new Date() };
        await adapter.upsertJob({ ...base, id: "j1", status: "completed" });
        await adapter.upsertJob({ ...base, id: "j2", status: "failed" });

        const completed = await adapter.listJobs({ status: "completed" });
        expect(completed.length).toBe(1);
        expect(completed[0].id).toBe("j1");
      });
    });

    describe("System Stats", () => {
      it("aggregates stats correctly", async () => {
        const base = { type: "task" as const, queueName: "q", opts: {}, attemptMade: 0, progressPercent: 0, tags: [], createdAt: new Date() };
        await adapter.upsertJob({ ...base, id: "j1", status: "active" });
        await adapter.upsertJob({ ...base, id: "j2", status: "completed" });

        const stats = await adapter.getSystemStats();
        expect(stats.counts.jobs.active).toBe(1);
        expect(stats.counts.jobs.completed).toBe(1);
      });
    });
  });
}

runAdapterContractTests("MemoryAdapter", () => new MemoryAdapter());
