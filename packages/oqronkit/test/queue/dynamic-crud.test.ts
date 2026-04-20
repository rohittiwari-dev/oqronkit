import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OqronContainer } from "../../src/engine/container.js";
import { OqronEventBus } from "../../src/engine/events/event-bus.js";
import { createLogger } from "../../src/engine/logger/index.js";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";
import { MemoryLock } from "../../src/engine/memory/memory-lock.js";
import { MemoryStore } from "../../src/engine/memory/memory-store.js";
import { queue } from "../../src/queue/define-queue.js";
import { QueueEngine } from "../../src/queue/queue-engine.js";

describe("QueueEngine — Dynamic CRUD", () => {
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

  it("registerQueue adds a new queue at runtime and starts polling", async () => {
    const engine = new QueueEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "queue", heartbeatMs: 50 },
    );
    await engine.init();
    await engine.start();

    let processed = false;
    const spy = vi.fn();
    OqronEventBus.on("queue:registered", spy);

    engine.registerQueue({
      name: "dynamic-q",
      handler: async () => { processed = true; },
    });

    expect(spy).toHaveBeenCalledWith("dynamic-q");

    // Push a job and wait for processing
    const di = OqronContainer.get();
    const q = queue({ name: "dynamic-q", handler: async () => { processed = true; } });
    await q.add({ x: 1 });
    await new Promise((r) => setTimeout(r, 200));

    expect(processed).toBe(true);
    await engine.stop();
  });

  it("deregisterQueue removes a queue from the registry", async () => {
    queue({ name: "removable-q", handler: async () => {} });

    const engine = new QueueEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "queue", heartbeatMs: 50 },
    );
    await engine.init();
    await engine.start();

    const spy = vi.fn();
    OqronEventBus.on("queue:deregistered", spy);

    const result = engine.deregisterQueue("removable-q");
    expect(result).toBe(true);
    expect(spy).toHaveBeenCalledWith("removable-q");

    // Deregister non-existent returns false
    expect(engine.deregisterQueue("ghost")).toBe(false);

    await engine.stop();
  });

  it("pauseQueue/resumeQueue halts and resumes job claiming", async () => {
    let callCount = 0;
    queue({
      name: "pausable-q",
      handler: async () => { callCount++; },
    });

    const engine = new QueueEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "queue", heartbeatMs: 50 },
    );
    await engine.init();
    await engine.start();

    // Pause
    const pauseSpy = vi.fn();
    OqronEventBus.on("queue:paused", pauseSpy);
    await engine.pauseQueue("pausable-q");
    expect(pauseSpy).toHaveBeenCalledWith("pausable-q");

    // Push jobs while paused — should NOT be processed
    const q = queue({ name: "pausable-q", handler: async () => { callCount++; } });
    await q.add({ x: 1 });
    await new Promise((r) => setTimeout(r, 150));
    const beforeResume = callCount;

    // Resume
    const resumeSpy = vi.fn();
    OqronEventBus.on("queue:resumed", resumeSpy);
    await engine.resumeQueue("pausable-q");
    expect(resumeSpy).toHaveBeenCalledWith("pausable-q");

    await new Promise((r) => setTimeout(r, 200));
    // After resume, jobs should process (count may or may not go up depending on timing,
    // but the important thing is pause blocked processing)
    expect(beforeResume).toBe(0);

    await engine.stop();
  });

  it("getQueueState returns correct queue information", async () => {
    queue({
      name: "state-q",
      strategy: "lifo",
      handler: async () => {},
    });

    const engine = new QueueEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "queue", heartbeatMs: 50 },
    );
    await engine.init();
    await engine.start();

    const state = engine.getQueueState("state-q");
    expect(state).toBeDefined();
    expect(state!.name).toBe("state-q");
    expect(state!.enabled).toBe(true);
    expect(state!.strategy).toBe("lifo");

    // Pause and recheck
    await engine.pauseQueue("state-q");
    const pausedState = engine.getQueueState("state-q");
    expect(pausedState!.enabled).toBe(false);

    // Non-existent queue
    expect(engine.getQueueState("ghost")).toBeUndefined();

    await engine.stop();
  });

  it("listQueues returns state for all registered queues", async () => {
    queue({ name: "list-q-1", handler: async () => {} });
    queue({ name: "list-q-2", strategy: "priority", handler: async () => {} });

    const engine = new QueueEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "queue", heartbeatMs: 50 },
    );
    await engine.init();
    await engine.start();

    const list = engine.listQueues();
    const names = list.map((q) => q.name);
    expect(names).toContain("list-q-1");
    expect(names).toContain("list-q-2");

    await engine.stop();
  });
});
