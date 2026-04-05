import { expect, test } from "vitest";
import { DependencyResolver } from "../../src/engine/utils/dependency-resolver.js";
import { MemoryStore } from "../../src/engine/memory/memory-store.js";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";
import type { OqronJob } from "../../src/engine/types/job.types.js";

test("Dependency cycle fails gracefully without infinite recursion", async () => {
  const store = new MemoryStore();
  const broker = new MemoryBroker();

  const jobA: OqronJob = {
    id: "A", type: "task", queueName: "test", status: "failed", data: {}, attemptMade: 0, progressPercent: 0, tags: [],
    opts: { dependsOn: ["B"], parentFailurePolicy: "cascade-fail" },
    childrenIds: ["B"],
    createdAt: new Date(),
  };

  const jobB: OqronJob = {
    id: "B", type: "task", queueName: "test", status: "waiting-children", data: {}, attemptMade: 0, progressPercent: 0, tags: [],
    opts: { dependsOn: ["A"], parentFailurePolicy: "cascade-fail" },
    childrenIds: ["A"],
    createdAt: new Date(),
  };

  await store.save("jobs", "A", jobA);
  await store.save("jobs", "B", jobB);

  // Trigger notify (would infinite loop if not safe)
  await DependencyResolver.notifyChildren(store, broker, "A");

  // B should now be failed due to cascade
  const b2 = await store.get<OqronJob>("jobs", "B");
  expect(b2?.status).toBe("failed");
});

