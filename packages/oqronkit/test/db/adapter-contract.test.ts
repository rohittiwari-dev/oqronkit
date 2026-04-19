import { describe, it, expect, beforeEach } from "vitest";
import { MemoryStore } from "../../src/engine/memory/memory-store.js";
import type { IStorageEngine } from "../../src/engine/types/engine.js";
import type { OqronJob } from "../../src/engine/types/job.types.js";

/**
 * IStorageEngine Contract Tests
 *
 * Verifies that every Engine implementation follows the unified storage model.
 */
function runStorageContractTests(
  name: string,
  createStore: () => IStorageEngine,
) {
  describe(`${name} — IStorageEngine Contract`, () => {
    let store: IStorageEngine;

    beforeEach(() => {
      store = createStore();
    });

    describe("Namespaced Entities", () => {
      it("saves and retrieves an entity", async () => {
        await store.save("schedules", "test-cron", {
          name: "test-cron",
          expression: "*/5 * * * *",
          missedFire: "skip"
        });

        const retrieved = await store.get<any>("schedules", "test-cron");
        expect(retrieved?.name).toBe("test-cron");
        expect(retrieved?.missedFire).toBe("skip");
      });

      it("lists and filters entities", async () => {
        await store.save("schedules", "p-1", { name: "p-1", status: "paused" });
        await store.save("schedules", "p-2", { name: "p-2", status: "active" });

        const all = await store.list<any>("schedules");
        expect(all.length).toBe(2);

        const paused = await store.list<any>("schedules", { status: "paused" });
        expect(paused.length).toBe(1);
        expect(paused[0].name).toBe("p-1");
      });

      it("deletes entities", async () => {
        await store.save("schedules", "to-delete", { name: "bye" });
        await store.delete("schedules", "to-delete");
        
        const fetched = await store.get("schedules", "to-delete");
        expect(fetched).toBeNull();
      });
    });

    describe("Memory Pruning", () => {
      it("prunes old entities based on property", async () => {
        // Use a generic pruning capability
        // This relies on whatever standard contract the engine implements.
        // E.g. pruning completed jobs older than X ms based on `finishedAt`
        await store.save("jobs", "j1", { id: "j1", createdAt: new Date(Date.now() - 100000) });
        await store.save("jobs", "j2", { id: "j2", createdAt: new Date(Date.now() - 100) });

        const pruned = await store.prune("jobs", Date.now() - 50000);
        expect(pruned).toBe(1);

        const remaining = await store.list<any>("jobs");
        expect(remaining.length).toBe(1);
        expect(remaining[0].id).toBe("j2");
      });
    });

    describe("E1: WhereCondition queries", () => {
      it("$lte returns only records with field <= value", async () => {
        const now = new Date();
        const past = new Date(now.getTime() - 60_000);
        const future = new Date(now.getTime() + 60_000);

        await store.save("schedules", "due", { name: "due", nextRunAt: past });
        await store.save("schedules", "notdue", { name: "notdue", nextRunAt: future });

        const due = await store.list<any>("schedules", undefined, {
          where: [{ field: "nextRunAt", op: "$lte", value: now }],
        });

        expect(due.length).toBe(1);
        expect(due[0].name).toBe("due");
      });

      it("$gte returns only records with field >= value", async () => {
        const now = new Date();
        const past = new Date(now.getTime() - 60_000);
        const future = new Date(now.getTime() + 60_000);

        await store.save("schedules", "old", { name: "old", nextRunAt: past });
        await store.save("schedules", "new", { name: "new", nextRunAt: future });

        const upcoming = await store.list<any>("schedules", undefined, {
          where: [{ field: "nextRunAt", op: "$gte", value: now }],
        });

        expect(upcoming.length).toBe(1);
        expect(upcoming[0].name).toBe("new");
      });

      it("null field values are excluded from where comparisons", async () => {
        const now = new Date();
        const past = new Date(now.getTime() - 60_000);

        await store.save("schedules", "has-date", { name: "has-date", nextRunAt: past });
        await store.save("schedules", "no-date", { name: "no-date", nextRunAt: null });
        await store.save("schedules", "undef-date", { name: "undef-date" });

        const due = await store.list<any>("schedules", undefined, {
          where: [{ field: "nextRunAt", op: "$lte", value: now }],
        });

        expect(due.length).toBe(1);
        expect(due[0].name).toBe("has-date");
      });

      it("where + exact filter combine correctly", async () => {
        const now = new Date();
        const past = new Date(now.getTime() - 60_000);

        await store.save("schedules", "due-active", {
          name: "due-active", nextRunAt: past, type: "cron",
        });
        await store.save("schedules", "due-schedule", {
          name: "due-schedule", nextRunAt: past, type: "schedule",
        });

        const cronOnly = await store.list<any>("schedules", { type: "cron" }, {
          where: [{ field: "nextRunAt", op: "$lte", value: now }],
        });

        expect(cronOnly.length).toBe(1);
        expect(cronOnly[0].name).toBe("due-active");
      });
    });
  });
}

runStorageContractTests("MemoryStore", () => new MemoryStore());
