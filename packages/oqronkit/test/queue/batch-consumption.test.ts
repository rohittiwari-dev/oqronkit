import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { OqronKit } from "../../src/index.js";
import { queue } from "../../src/queue/define-queue.js";

describe("Batch Consumption", () => {
  let q: any;
  let batchProcessed = false;
  let jobCount = 0;

  beforeEach(async () => {
    q = queue({
      name: "batch-test",
      batchSize: 5,
      processBatch: async (jobs) => {
        batchProcessed = true;
        jobCount = jobs.length;
        return jobs.map((j) => ({ status: "fulfilled" as const, value: `ok-${j.id}` }));
      },
    });

    await OqronKit.init({
      config: {
        environment: "test",
        project: "test",
        modules: ["queue"],
        triggers: false,
      }
    });
  });

  afterEach(async () => {
    await OqronKit.stop();
    batchProcessed = false;
    jobCount = 0;
  });

  it("should process jobs in a batch all at once", async () => {
    await q.addBulk([
      { data: 1 },
      { data: 2 },
      { data: 3 },
    ]);

    await new Promise((r) => setTimeout(r, 200));

    expect(batchProcessed).toBe(true);
    expect(jobCount).toBe(3);
  });
});
