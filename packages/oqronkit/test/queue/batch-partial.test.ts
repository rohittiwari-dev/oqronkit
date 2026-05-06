import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { OqronKit } from "../../src/index.js";
import { Storage } from "../../src/engine/index.js";
import { queue } from "../../src/queue/define-queue.js";
import type { OqronJob } from "../../src/engine/types/job.types.js";

describe("Batch Partial Responses", () => {
  let q: any;

  beforeEach(async () => {
    q = queue({
      name: "partial-batch",
      batchSize: 5,
      retries: { max: 0 },
      processBatch: async (jobs) => {
        return jobs.map((j, i) => {
          if (i === 1) return { status: "rejected" as const, reason: new Error("job-1-fail") };
          return { status: "fulfilled" as const, value: `ok-${i}` };
        });
      },
    });

    await OqronKit.init({
      config: { environment: "test", project: "test", modules: ["queue"], triggers: false }
    });
  });

  afterEach(async () => {
    await OqronKit.stop();
  });

  it("should complete fulfilled jobs and fail rejected jobs independently", async () => {
    const added = await q.addBulk([
      { data: "a" },
      { data: "b" },
      { data: "c" },
    ]);

    await new Promise((r) => setTimeout(r, 300));

    const job0 = await Storage.get<OqronJob>("jobs", added[0].id);
    const job1 = await Storage.get<OqronJob>("jobs", added[1].id);
    const job2 = await Storage.get<OqronJob>("jobs", added[2].id);

    expect(job0?.status).toBe("completed");
    expect(job2?.status).toBe("completed");
    expect(job1?.status).toBe("failed");
    expect(job1?.error).toContain("job-1-fail");
  });
});
