import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OqronContainer } from "../../src/engine/container.js";
import { OqronEventBus } from "../../src/engine/events/event-bus.js";
import { createLogger } from "../../src/engine/logger/index.js";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";
import { MemoryLock } from "../../src/engine/memory/memory-lock.js";
import { MemoryStore } from "../../src/engine/memory/memory-store.js";
import { queue } from "../../src/queue/define-queue.js";
import { QueueEngine } from "../../src/queue/queue-engine.js";

describe("Queue — Tags, Hooks, Context Enrichment", () => {
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

  it("tags flow from config into job record", async () => {
    const q = queue({
      name: "tagged-q",
      tags: ["billing", "high-priority"],
      handler: async () => {},
    });

    const job = await q.add({ x: 1 });
    expect(job.tags).toEqual(["billing", "high-priority"]);
  });

  it("beforeRun hook is called before handler execution", async () => {
    const callOrder: string[] = [];

    const q = queue({
      name: "hook-q",
      hooks: {
        beforeRun: async () => { callOrder.push("beforeRun"); },
        onSuccess: async () => { callOrder.push("onSuccess"); },
      },
      handler: async () => { callOrder.push("handler"); },
    });

    const engine = new QueueEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "queue", heartbeatMs: 50 },
    );
    await engine.init();
    await engine.start();

    await q.add({ x: 1 });
    await new Promise((r) => setTimeout(r, 300));

    expect(callOrder[0]).toBe("beforeRun");
    expect(callOrder[1]).toBe("handler");

    await engine.stop();
  });

  it("context exposes name, attempt, maxAttempts, createdAt, aborted", async () => {
    let ctxSnapshot: any = null;

    const q = queue({
      name: "ctx-q",
      handler: async (ctx) => {
        ctxSnapshot = {
          name: ctx.name,
          attempt: ctx.attempt,
          maxAttempts: ctx.maxAttempts,
          hasCreatedAt: ctx.createdAt instanceof Date,
          aborted: ctx.aborted,
          hasSignal: !!ctx.signal,
        };
      },
    });

    const engine = new QueueEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "queue", heartbeatMs: 50 },
    );
    await engine.init();
    await engine.start();

    await q.add({ x: 1 });
    await new Promise((r) => setTimeout(r, 300));

    expect(ctxSnapshot).toBeDefined();
    expect(ctxSnapshot.name).toBe("ctx-q");
    expect(ctxSnapshot.attempt).toBe(1);
    expect(ctxSnapshot.maxAttempts).toBe(1);
    expect(ctxSnapshot.hasCreatedAt).toBe(true);
    expect(ctxSnapshot.aborted).toBe(false);
    expect(ctxSnapshot.hasSignal).toBe(true);

    await engine.stop();
  });
});
