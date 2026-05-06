import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OqronContainer } from "../../src/engine/container.js";
import { OqronEventBus } from "../../src/engine/events/event-bus.js";
import { createLogger } from "../../src/engine/logger/index.js";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";
import { MemoryLock } from "../../src/engine/memory/memory-lock.js";
import { MemoryStore } from "../../src/engine/memory/memory-store.js";
import { queue } from "../../src/queue/define-queue.js";
import { QueueEngine } from "../../src/queue/queue-engine.js";

describe("Phase 4 — DX3: Hook Signature Unification", () => {
  const logger = createLogger({ enabled: false }, { module: "test" });

  beforeEach(() => {
    OqronContainer.init(new MemoryStore(), new MemoryBroker(), new MemoryLock(), {
      project: "test",
      environment: "test",
    });
  });

  afterEach(() => {
    OqronContainer.reset();
    OqronEventBus.removeAllListeners();
  });

  it("afterRun hook fires on successful handler completion", async () => {
    let afterRunCalled = false;
    let afterRunResult: any = null;

    const q = queue<{ x: number }, string>({
      name: "afterrun-hook-q",
      hooks: {
        afterRun: (job, result) => {
          afterRunCalled = true;
          afterRunResult = result;
        },
      },
      handler: async () => "done!",
    });

    await q.add({ x: 1 });

    const engine = new QueueEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "queue", heartbeatMs: 50 },
    );
    await engine.init();
    await engine.start();
    await new Promise((r) => setTimeout(r, 500));
    await engine.stop();

    expect(afterRunCalled).toBe(true);
    expect(afterRunResult).toBe("done!");
  });

  it("onError hook fires on handler failure", async () => {
    let onErrorCalled = false;
    let onErrorMsg = "";

    const q = queue<{ x: number }>({
      name: "onerror-hook-q",
      hooks: {
        onError: (job, error) => {
          onErrorCalled = true;
          onErrorMsg = error.message;
        },
      },
      handler: async () => {
        throw new Error("handler-exploded");
      },
    });

    await q.add({ x: 1 });

    const engine = new QueueEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "queue", heartbeatMs: 50 },
    );
    await engine.init();
    await engine.start();
    await new Promise((r) => setTimeout(r, 500));
    await engine.stop();

    expect(onErrorCalled).toBe(true);
    expect(onErrorMsg).toBe("handler-exploded");
  });

  it("both onSuccess and afterRun fire when both are set", async () => {
    let onSuccessCalled = false;
    let afterRunCalled = false;

    const q = queue<{ x: number }>({
      name: "dual-success-hooks-q",
      hooks: {
        onSuccess: () => {
          onSuccessCalled = true;
        },
        afterRun: () => {
          afterRunCalled = true;
        },
      },
      handler: async () => "ok",
    });

    await q.add({ x: 1 });

    const engine = new QueueEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "queue", heartbeatMs: 50 },
    );
    await engine.init();
    await engine.start();
    await new Promise((r) => setTimeout(r, 500));
    await engine.stop();

    expect(onSuccessCalled).toBe(true);
    expect(afterRunCalled).toBe(true);
  });

  it("both onFail and onError fire when both are set", async () => {
    let onFailCalled = false;
    let onErrorCalled = false;

    const q = queue<{ x: number }>({
      name: "dual-fail-hooks-q",
      hooks: {
        onFail: () => {
          onFailCalled = true;
        },
        onError: () => {
          onErrorCalled = true;
        },
      },
      handler: async () => {
        throw new Error("fail");
      },
    });

    await q.add({ x: 1 });

    const engine = new QueueEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "queue", heartbeatMs: 50 },
    );
    await engine.init();
    await engine.start();
    await new Promise((r) => setTimeout(r, 500));
    await engine.stop();

    expect(onFailCalled).toBe(true);
    expect(onErrorCalled).toBe(true);
  });
});
