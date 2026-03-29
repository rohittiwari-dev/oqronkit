import { describe, it, expect, beforeEach } from "vitest";
import { MemoryStore } from "../../src/engine/memory/memory-store.js";

describe("MemoryStore — list() pagination & count()", () => {
  let store: MemoryStore;

  beforeEach(async () => {
    store = new MemoryStore();

    // Seed 20 jobs with staggered timestamps
    for (let i = 0; i < 20; i++) {
      await store.save("jobs", `job-${i}`, {
        id: `job-${i}`,
        queueName: i < 10 ? "queue-a" : "queue-b",
        status: i % 3 === 0 ? "completed" : "waiting",
        createdAt: new Date(Date.now() - (20 - i) * 1000), // oldest first
      });
    }
  });

  it("should return all items when no limit is specified", async () => {
    const all = await store.list("jobs");
    expect(all.length).toBe(20);
  });

  it("should respect limit parameter", async () => {
    const page = await store.list("jobs", undefined, { limit: 5 });
    expect(page.length).toBe(5);
  });

  it("should respect offset parameter", async () => {
    const all = await store.list<any>("jobs");
    const page = await store.list<any>("jobs", undefined, { offset: 5, limit: 5 });
    expect(page.length).toBe(5);
    // The page should start at the 6th item
    expect(page[0].id).toBe(all[5].id);
  });

  it("should apply filter AND pagination together", async () => {
    const filtered = await store.list<any>("jobs", { queueName: "queue-a" }, { limit: 3 });
    expect(filtered.length).toBe(3);
    for (const item of filtered) {
      expect(item.queueName).toBe("queue-a");
    }
  });

  it("count() should return total without filter", async () => {
    const total = await store.count("jobs");
    expect(total).toBe(20);
  });

  it("count() should return filtered count", async () => {
    const countA = await store.count("jobs", { queueName: "queue-a" });
    expect(countA).toBe(10);

    const countCompleted = await store.count("jobs", { status: "completed" });
    // Jobs 0,3,6,9,12,15,18 = 7 completed
    expect(countCompleted).toBe(7);
  });

  it("count() should return 0 for empty namespace", async () => {
    const count = await store.count("nonexistent");
    expect(count).toBe(0);
  });
});
