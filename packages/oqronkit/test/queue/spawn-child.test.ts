import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { OqronKit } from "../../src/index.js";
import { Storage } from "../../src/engine/index.js";
import { queue } from "../../src/queue/define-queue.js";
import { OqronJob } from "../../src/engine/types/job.types.js";

describe("Dynamic Child Spawning", () => {
  let parentQ: any;
  let childId: string | undefined;

  beforeEach(async () => {
    queue({
      name: "child-q",
      handler: async () => "ok",
    });

    parentQ = queue({
      name: "parent-q",
      handler: async (ctx) => {
        childId = await ctx.spawnChild("child-q", { childData: true });
        return "parent ok";
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
    childId = undefined;
  });

  it("should spawn a child job and link parentId and childrenIds", async () => {


    const parentJob = await parentQ.add({ parentData: true });

    // Wait for jobs to process
    await new Promise((r) => setTimeout(r, 200));

    expect(childId).toBeDefined();

    const pJob = await Storage.get<OqronJob>("jobs", parentJob.id);
    const cJob = await Storage.get<OqronJob>("jobs", childId!);

    expect(pJob?.childrenIds).toContain(childId);
    expect(cJob?.parentId).toBe(parentJob.id);
  });
});
