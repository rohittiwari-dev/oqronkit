import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OqronContainer } from "../../src/engine/container.js";
import { OqronEventBus } from "../../src/engine/events/event-bus.js";
import { createLogger } from "../../src/engine/logger/index.js";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";
import { MemoryLock } from "../../src/engine/memory/memory-lock.js";
import { MemoryStore } from "../../src/engine/memory/memory-store.js";
import { queue } from "../../src/queue/define-queue.js";
import { worker } from "../../src/worker/define-worker.js";
import { WorkerEngine } from "../../src/worker/worker-engine.js";

describe("WorkerEngine — Dynamic CRUD", () => {
  const logger = createLogger({ enabled: false }, { module: "test" });

  beforeEach(() => {
    const store = new MemoryStore();
    const broker = new MemoryBroker();
    const lock = new MemoryLock();
    OqronContainer.init(store, broker, lock, {
      project: "test",
      environment: "test",
    });
  });

  afterEach(() => {
    OqronContainer.reset();
    OqronEventBus.removeAllListeners();
  });

  it("registerWorker adds a new worker at runtime and starts polling", async () => {
    const engine = new WorkerEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "worker", heartbeatMs: 50 },
    );
    await engine.init();
    await engine.start();

    let processed = false;
    const spy = vi.fn();
    OqronEventBus.on("worker:registered", spy);

    engine.registerWorker({
      topic: "dynamic-w",
      handler: async () => { processed = true; },
    });
    expect(spy).toHaveBeenCalledWith("dynamic-w");

    // Push a job via publisher queue
    const pub = queue({ name: "dynamic-w" });
    await pub.add({ x: 1 });
    await new Promise((r) => setTimeout(r, 200));

    expect(processed).toBe(true);
    await engine.stop();
  });

  it("deregisterWorker removes a worker", async () => {
    worker({ topic: "removable-w", handler: async () => {} });

    const engine = new WorkerEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "worker", heartbeatMs: 50 },
    );
    await engine.init();
    await engine.start();

    const spy = vi.fn();
    OqronEventBus.on("worker:deregistered", spy);

    expect(engine.deregisterWorker("removable-w")).toBe(true);
    expect(spy).toHaveBeenCalledWith("removable-w");
    expect(engine.deregisterWorker("ghost")).toBe(false);

    await engine.stop();
  });

  it("pauseWorker/resumeWorker halts and resumes processing", async () => {
    let callCount = 0;
    worker({
      topic: "pausable-w",
      handler: async () => { callCount++; },
    });

    const engine = new WorkerEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "worker", heartbeatMs: 50 },
    );
    await engine.init();
    await engine.start();

    // Pause
    engine.pauseWorker("pausable-w");

    // Push jobs while paused
    const pub = queue({ name: "pausable-w" });
    await pub.add({ x: 1 });
    await new Promise((r) => setTimeout(r, 150));
    expect(callCount).toBe(0);

    // Resume
    engine.resumeWorker("pausable-w");
    await new Promise((r) => setTimeout(r, 200));
    expect(callCount).toBeGreaterThan(0);

    await engine.stop();
  });

  it("getWorkerState returns correct worker information", async () => {
    worker({
      topic: "state-w",
      concurrency: 3,
      handler: async () => {},
    });

    const engine = new WorkerEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "worker", heartbeatMs: 50 },
    );
    await engine.init();
    await engine.start();

    const state = engine.getWorkerState("state-w");
    expect(state).toBeDefined();
    expect(state!.topic).toBe("state-w");
    expect(state!.enabled).toBe(true);
    expect(state!.concurrency).toBe(3);

    engine.pauseWorker("state-w");
    expect(engine.getWorkerState("state-w")!.enabled).toBe(false);
    expect(engine.getWorkerState("ghost")).toBeUndefined();

    await engine.stop();
  });

  it("listWorkers returns state for all workers", async () => {
    worker({ topic: "list-w-1", handler: async () => {} });
    worker({ topic: "list-w-2", concurrency: 10, handler: async () => {} });

    const engine = new WorkerEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "worker", heartbeatMs: 50 },
    );
    await engine.init();
    await engine.start();

    const list = engine.listWorkers();
    const topics = list.map((w) => w.topic);
    expect(topics).toContain("list-w-1");
    expect(topics).toContain("list-w-2");

    const w2 = list.find((w) => w.topic === "list-w-2");
    expect(w2!.concurrency).toBe(10);

    await engine.stop();
  });
});
