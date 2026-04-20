import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { OqronKit } from "../../src/index.js";
import { Storage } from "../../src/engine/index.js";
import { queue } from "../../src/queue/define-queue.js";
import type { OqronJob } from "../../src/engine/types/job.types.js";

describe("Batch Discard", () => {
  let q: any;

  beforeEach(async () => {
    q = queue({
      name: "discard-batch",
      batchSize: 5,
      processBatch: async (jobs) => {
        jobs[1].discard();
        return jobs.map(() => ({ status: "fulfilled" as const, value: "done" }));
      },
    });

    await OqronKit.init({
      config: { environment: "test", project: "test", modules: ["queue"], triggers: false }
    });
  });

  afterEach(async () => {
    await OqronKit.stop();
  });

  it("should silently ack discarded jobs in a batch", async () => {
    const added = await q.addBulk([
      { data: "x" },
      { data: "y" },
      { data: "z" },
    ]);

    await new Promise((r) => setTimeout(r, 300));

    const job0 = await Storage.get<OqronJob>("jobs", added[0].id);
    const job1 = await Storage.get<OqronJob>("jobs", added[1].id);
    const job2 = await Storage.get<OqronJob>("jobs", added[2].id);

    expect(job0?.status).toBe("completed");
    expect(job2?.status).toBe("completed");
    expect(job1?.status).toBe("completed");
    expect(job1?.progressLabel).toBe("Discarded");
  });
});
