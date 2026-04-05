import { expect, test } from "vitest";
import { DependencyResolver } from "../../src/engine/utils/dependency-resolver.js";
import { MemoryStore } from "../../src/engine/memory/memory-store.js";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";
import type { OqronJob } from "../../src/engine/types/job.types.js";

test("Diamond dependency resolution (D depends on B and C, B and C depend on A)", async () => {
  const store = new MemoryStore();
  const broker = new MemoryBroker();
  
  const createJob = (id: string, dependsOn: string[], childrenIds: string[], status: any) => ({
    id, type: "task", queueName: "test", status, data: {}, attemptMade: 0, progressPercent: 0, tags: [],
    opts: { dependsOn }, childrenIds, createdAt: new Date()
  } as OqronJob);

  await store.save("jobs", "A", createJob("A", [], ["B", "C"], "completed"));
  await store.save("jobs", "B", createJob("B", ["A"], ["D"], "waiting-children"));
  await store.save("jobs", "C", createJob("C", ["A"], ["D"], "waiting-children"));
  await store.save("jobs", "D", createJob("D", ["B", "C"], [], "waiting-children"));

  // Process A completion
  await DependencyResolver.notifyChildren(store, broker, "A");

  // B and C should now be waiting
  expect((await store.get<OqronJob>("jobs", "B"))?.status).toBe("waiting");
  expect((await store.get<OqronJob>("jobs", "C"))?.status).toBe("waiting");
  
  // D is still waiting-children because only A finished (which cascaded to B and C getting ready, but they didn't finish)
  expect((await store.get<OqronJob>("jobs", "D"))?.status).toBe("waiting-children");

  // Manually finish B
  let updateB = await store.get<OqronJob>("jobs", "B");
  if (updateB) { updateB.status = "completed"; await store.save("jobs", "B", updateB); }
  await DependencyResolver.notifyChildren(store, broker, "B");
  
  // D should STILL be waiting-children because C hasn't finished
  expect((await store.get<OqronJob>("jobs", "D"))?.status).toBe("waiting-children");

  // Manually finish C
  let updateC = await store.get<OqronJob>("jobs", "C");
  if (updateC) { updateC.status = "completed"; await store.save("jobs", "C", updateC); }
  await DependencyResolver.notifyChildren(store, broker, "C");

  // Now D should be promoted to waiting
  expect((await store.get<OqronJob>("jobs", "D"))?.status).toBe("waiting");
});
