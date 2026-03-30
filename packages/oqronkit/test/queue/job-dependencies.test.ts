import { describe, expect, it, beforeEach } from "vitest";
import { DependencyResolver } from "../../src/engine/utils/dependency-resolver.js";
import type { OqronJob } from "../../src/engine/types/job.types.js";

// ── In-memory mock adapters ──────────────────────────────────────────────────

function createMockStorage() {
  const store = new Map<string, Map<string, any>>();

  return {
    save: async (ns: string, key: string, val: any) => {
      if (!store.has(ns)) store.set(ns, new Map());
      store.get(ns)!.set(key, JSON.parse(JSON.stringify(val)));
    },
    get: async <T>(ns: string, key: string): Promise<T | null> => {
      return (store.get(ns)?.get(key) ?? null) as T | null;
    },
    list: async <T>(ns: string): Promise<T[]> => {
      return Array.from(store.get(ns)?.values() ?? []) as T[];
    },
    remove: async (ns: string, key: string) => {
      store.get(ns)?.delete(key);
    },
    _store: store,
  };
}

function createMockBroker() {
  const published: Array<{ queue: string; jobId: string }> = [];
  return {
    publish: async (queue: string, jobId: string) => {
      published.push({ queue, jobId });
    },
    claim: async () => [],
    ack: async () => {},
    nack: async () => {},
    subscribe: async () => {},
    published,
  };
}

function makeJob(id: string, status: string, dependsOn?: string[]): OqronJob {
  return {
    id,
    type: "task",
    queueName: "test",
    status: status as any,
    data: {},
    opts: dependsOn ? { dependsOn } : {},
    attemptMade: 0,
    progressPercent: 0,
    tags: [],
    createdAt: new Date(),
  };
}

describe("DependencyResolver", () => {
  let storage: ReturnType<typeof createMockStorage>;
  let broker: ReturnType<typeof createMockBroker>;

  beforeEach(() => {
    storage = createMockStorage();
    broker = createMockBroker();
  });

  // ── canProceed ────────────────────────────────────────────────────────────

  it("returns true when all parents are completed", async () => {
    await storage.save("jobs", "p1", makeJob("p1", "completed"));
    await storage.save("jobs", "p2", makeJob("p2", "completed"));

    const result = await DependencyResolver.canProceed(storage as any, [
      "p1",
      "p2",
    ]);
    expect(result).toBe(true);
  });

  it("returns false when a parent is still waiting", async () => {
    await storage.save("jobs", "p1", makeJob("p1", "completed"));
    await storage.save("jobs", "p2", makeJob("p2", "waiting"));

    const result = await DependencyResolver.canProceed(storage as any, [
      "p1",
      "p2",
    ]);
    expect(result).toBe(false);
  });

  it("returns false when a parent does not exist", async () => {
    const result = await DependencyResolver.canProceed(storage as any, [
      "nonexistent",
    ]);
    expect(result).toBe(false);
  });

  // ── notifyChildren ────────────────────────────────────────────────────────

  it("promotes child to waiting when all parents complete", async () => {
    const parent = makeJob("p1", "completed");
    parent.childrenIds = ["child1"];
    await storage.save("jobs", "p1", parent);

    const child = makeJob("child1", "waiting-children", ["p1"]);
    await storage.save("jobs", "child1", child);

    await DependencyResolver.notifyChildren(storage as any, broker as any, "p1");

    const updated = await storage.get<OqronJob>("jobs", "child1");
    expect(updated!.status).toBe("waiting");
    expect(broker.published).toHaveLength(1);
    expect(broker.published[0].jobId).toBe("child1");
  });

  it("keeps child in waiting-children when only one parent completes", async () => {
    const p1 = makeJob("p1", "completed");
    p1.childrenIds = ["child1"];
    await storage.save("jobs", "p1", p1);

    const p2 = makeJob("p2", "waiting");
    await storage.save("jobs", "p2", p2);

    const child = makeJob("child1", "waiting-children", ["p1", "p2"]);
    await storage.save("jobs", "child1", child);

    await DependencyResolver.notifyChildren(storage as any, broker as any, "p1");

    const updated = await storage.get<OqronJob>("jobs", "child1");
    expect(updated!.status).toBe("waiting-children");
    expect(broker.published).toHaveLength(0);
  });

  it("cascade-fails child when parent fails with cascade-fail policy", async () => {
    const parent = makeJob("p1", "failed");
    parent.childrenIds = ["child1"];
    await storage.save("jobs", "p1", parent);

    const child = makeJob("child1", "waiting-children", ["p1"]);
    child.opts.parentFailurePolicy = "cascade-fail";
    await storage.save("jobs", "child1", child);

    await DependencyResolver.notifyChildren(storage as any, broker as any, "p1");

    const updated = await storage.get<OqronJob>("jobs", "child1");
    expect(updated!.status).toBe("failed");
    expect(updated!.error).toContain("Parent job");
  });

  it("blocks child when parent fails with block policy (default)", async () => {
    const parent = makeJob("p1", "failed");
    parent.childrenIds = ["child1"];
    await storage.save("jobs", "p1", parent);

    const child = makeJob("child1", "waiting-children", ["p1"]);
    await storage.save("jobs", "child1", child);

    await DependencyResolver.notifyChildren(storage as any, broker as any, "p1");

    const updated = await storage.get<OqronJob>("jobs", "child1");
    expect(updated!.status).toBe("waiting-children"); // stays blocked
    expect(broker.published).toHaveLength(0);
  });

  it("promotes child when parent fails with ignore policy", async () => {
    const parent = makeJob("p1", "failed");
    parent.childrenIds = ["child1"];
    await storage.save("jobs", "p1", parent);

    const child = makeJob("child1", "waiting-children", ["p1"]);
    child.opts.parentFailurePolicy = "ignore";
    await storage.save("jobs", "child1", child);

    await DependencyResolver.notifyChildren(storage as any, broker as any, "p1");

    const updated = await storage.get<OqronJob>("jobs", "child1");
    expect(updated!.status).toBe("waiting");
    expect(broker.published).toHaveLength(1);
  });

  // ── registerDependencies ──────────────────────────────────────────────────

  it("adds childId to parent's childrenIds array", async () => {
    await storage.save("jobs", "p1", makeJob("p1", "waiting"));
    await storage.save("jobs", "p2", makeJob("p2", "waiting"));

    await DependencyResolver.registerDependencies(storage as any, "child1", [
      "p1",
      "p2",
    ]);

    const p1 = await storage.get<OqronJob>("jobs", "p1");
    const p2 = await storage.get<OqronJob>("jobs", "p2");
    expect(p1!.childrenIds).toContain("child1");
    expect(p2!.childrenIds).toContain("child1");
  });

  it("does not duplicate childId if called twice", async () => {
    await storage.save("jobs", "p1", makeJob("p1", "waiting"));

    await DependencyResolver.registerDependencies(storage as any, "child1", [
      "p1",
    ]);
    await DependencyResolver.registerDependencies(storage as any, "child1", [
      "p1",
    ]);

    const p1 = await storage.get<OqronJob>("jobs", "p1");
    expect(p1!.childrenIds!.filter((id) => id === "child1")).toHaveLength(1);
  });
});
