import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OqronContainer } from "../../src/engine/container.js";
import { createLogger } from "../../src/engine/logger/index.js";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";
import { MemoryLock } from "../../src/engine/memory/memory-lock.js";
import { MemoryStore } from "../../src/engine/memory/memory-store.js";
import { queue } from "../../src/queue/define-queue.js";
import { worker } from "../../src/worker/define-worker.js";
import { WorkerEngine } from "../../src/worker/worker-engine.js";

describe("WorkerEngine — LIFO & Priority Strategies", () => {
  const logger = createLogger({ enabled: false }, { module: "test" });

  beforeEach(() => {
    OqronContainer.init(new MemoryStore(), new MemoryBroker(), new MemoryLock(), {
      project: "test",
      environment: "test",
    });
  });

  afterEach(() => {
    OqronContainer.reset();
  });

  it("LIFO strategy claims the most recent job first", async () => {
    const processedOrder: number[] = [];

    worker<{ order: number }>({
      topic: "lifo-topic",
      strategy: "lifo",
      concurrency: 1,
      handler: async (ctx) => {
        processedOrder.push(ctx.data.order);
        await new Promise((r) => setTimeout(r, 10));
      },
    });

    const pub = queue<{ order: number }>({ name: "lifo-topic" });

    // Add jobs in order 1, 2, 3
    await pub.add({ order: 1 });
    await pub.add({ order: 2 });
    await pub.add({ order: 3 });

    const engine = new WorkerEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "worker", heartbeatMs: 50 },
    );
    await engine.start();
    await new Promise((r) => setTimeout(r, 800));
    await engine.stop();

    // In LIFO, job 3 should be processed first
    expect(processedOrder.length).toBeGreaterThanOrEqual(2);
    expect(processedOrder[0]).toBe(3);
  });

  it("Priority strategy claims lowest priority number first", async () => {
    const processedOrder: number[] = [];

    worker<{ order: number }>({
      topic: "priority-topic",
      strategy: "priority",
      concurrency: 1,
      handler: async (ctx) => {
        processedOrder.push(ctx.data.order);
        await new Promise((r) => setTimeout(r, 10));
      },
    });

    const pub = queue<{ order: number }>({ name: "priority-topic" });

    // Add jobs with different priorities (lower number = higher priority)
    await pub.add({ order: 3 }, { priority: 30 });
    await pub.add({ order: 1 }, { priority: 10 });
    await pub.add({ order: 2 }, { priority: 20 });

    const engine = new WorkerEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "worker", heartbeatMs: 50 },
    );
    await engine.start();
    await new Promise((r) => setTimeout(r, 800));
    await engine.stop();

    // Priority order: 10 → 20 → 30 (i.e., order 1, 2, 3)
    expect(processedOrder.length).toBeGreaterThanOrEqual(2);
    expect(processedOrder[0]).toBe(1);
  });
});
