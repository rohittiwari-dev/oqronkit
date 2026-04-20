import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OqronContainer } from "../../src/engine/container.js";
import { createLogger } from "../../src/engine/logger/index.js";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";
import { MemoryLock } from "../../src/engine/memory/memory-lock.js";
import { MemoryStore } from "../../src/engine/memory/memory-store.js";
import { queue } from "../../src/queue/define-queue.js";
import { QueueEngine } from "../../src/queue/queue-engine.js";
import type { OqronJob } from "../../src/engine/types/job.types.js";
import { getRegisteredQueues } from "../../src/queue/registry.js";

describe("Queue — Job Retention & Pruning", () => {
  const logger = createLogger({ enabled: false }, { module: "test" });

  beforeEach(() => {
    OqronContainer.init(new MemoryStore(), new MemoryBroker(), new MemoryLock(), {
      project: "test",
      environment: "test",
    });
    // Clear registry
    getRegisteredQueues().splice(0);
  });

  afterEach(() => {
    OqronContainer.reset();
  });

  it("removes completed jobs when removeOnComplete: true", async () => {
    const q = queue<{ x: number }>({
      name: "prune-complete",
      removeOnComplete: true,
      handler: async () => "done",
    });

    const job = await q.add({ x: 1 });
    const engine = new QueueEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "queue", heartbeatMs: 50 },
    );
    await engine.init();
    await engine.start();
    await new Promise((r) => setTimeout(r, 300));

    const di = OqronContainer.get();
    const stored = await di.storage.get<OqronJob>("jobs", job.id);
    // Job should be removed from storage after completion
    expect(stored).toBeNull();

    await engine.stop();
  });

  it("keeps N most recent jobs with removeOnComplete: { count: 2 }", async () => {
    const q = queue<{ idx: number }>({
      name: "prune-count",
      removeOnComplete: { count: 2 },
      handler: async () => "done",
    });

    // Add 4 jobs
    await q.add({ idx: 1 });
    await q.add({ idx: 2 });
    await q.add({ idx: 3 });
    await q.add({ idx: 4 });

    const engine = new QueueEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "queue", heartbeatMs: 50 },
    );
    await engine.init();
    await engine.start();
    await new Promise((r) => setTimeout(r, 800));

    const di = OqronContainer.get();
    const remaining = await di.storage.list<OqronJob>("jobs", {
      queueName: "prune-count",
      status: "completed",
    });
    // Should keep at most 2 completed jobs
    expect(remaining.length).toBeLessThanOrEqual(2);

    await engine.stop();
  });

  it("removes failed jobs when removeOnFail: true", async () => {
    const q = queue<{ x: number }>({
      name: "prune-fail",
      removeOnFail: true,
      handler: async () => {
        throw new Error("boom");
      },
    });

    const job = await q.add({ x: 1 });
    const engine = new QueueEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "queue", heartbeatMs: 50 },
    );
    await engine.init();
    await engine.start();
    await new Promise((r) => setTimeout(r, 300));

    const di = OqronContainer.get();
    const stored = await di.storage.get<OqronJob>("jobs", job.id);
    expect(stored).toBeNull();

    await engine.stop();
  });

  it("respects keepHistory: false (removes completed jobs)", async () => {
    const q = queue<{ x: number }>({
      name: "keep-history-false",
      keepHistory: false,
      handler: async () => "done",
    });

    const job = await q.add({ x: 1 });
    const engine = new QueueEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "queue", heartbeatMs: 50 },
    );
    await engine.init();
    await engine.start();
    await new Promise((r) => setTimeout(r, 300));

    const di = OqronContainer.get();
    const stored = await di.storage.get<OqronJob>("jobs", job.id);
    expect(stored).toBeNull();

    await engine.stop();
  });

  it("respects keepHistory: true (keeps all completed jobs)", async () => {
    const q = queue<{ x: number }>({
      name: "keep-history-true",
      keepHistory: true,
      handler: async () => "done",
    });

    const job = await q.add({ x: 1 });
    const engine = new QueueEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "queue", heartbeatMs: 50 },
    );
    await engine.init();
    await engine.start();
    await new Promise((r) => setTimeout(r, 300));

    const di = OqronContainer.get();
    const stored = await di.storage.get<OqronJob>("jobs", job.id);
    expect(stored).not.toBeNull();
    expect(stored?.status).toBe("completed");

    await engine.stop();
  });
});
