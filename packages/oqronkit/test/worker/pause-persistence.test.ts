import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OqronContainer } from "../../src/engine/container.js";
import { createLogger } from "../../src/engine/logger/index.js";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";
import { MemoryLock } from "../../src/engine/memory/memory-lock.js";
import { MemoryStore } from "../../src/engine/memory/memory-store.js";
import { queue } from "../../src/queue/define-queue.js";
import { worker } from "../../src/worker/define-worker.js";
import { WorkerEngine } from "../../src/worker/worker-engine.js";
import { getRegisteredWorkers } from "../../src/worker/registry.js";
import { getRegisteredQueues } from "../../src/queue/registry.js";
import type { OqronJob } from "../../src/engine/types/job.types.js";

describe("WorkerEngine — Pause Persistence", () => {
  const logger = createLogger({ enabled: false }, { module: "test" });

  beforeEach(() => {
    OqronContainer.init(new MemoryStore(), new MemoryBroker(), new MemoryLock(), {
      project: "test",
      environment: "test",
    });
    getRegisteredQueues().splice(0);
    getRegisteredWorkers().splice(0);
  });

  afterEach(() => {
    OqronContainer.reset();
  });

  it("persists pause state to storage", async () => {
    worker<{ x: number }>({
      topic: "persist-pause",
      handler: async () => "ok",
    });

    const engine = new WorkerEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "worker", heartbeatMs: 50 },
    );
    await engine.init();
    await engine.start();

    await engine.pauseWorker("persist-pause");

    const di = OqronContainer.get();
    const instance = await di.storage.get<any>("worker_instances", "persist-pause");
    expect(instance.enabled).toBe(false);

    await engine.stop();
  });

  it("persists resume state to storage", async () => {
    worker<{ x: number }>({
      topic: "persist-resume",
      handler: async () => "ok",
    });

    const engine = new WorkerEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "worker", heartbeatMs: 50 },
    );
    await engine.init();
    await engine.start();

    await engine.pauseWorker("persist-resume");
    await engine.resumeWorker("persist-resume");

    const di = OqronContainer.get();
    const instance = await di.storage.get<any>("worker_instances", "persist-resume");
    expect(instance.enabled).toBe(true);

    await engine.stop();
  });

  it("loads persisted pause state on init (survives restart)", async () => {
    worker<{ x: number }>({
      topic: "survive-restart",
      handler: async () => "ok",
    });

    // First engine instance — pause the worker
    const engine1 = new WorkerEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "worker", heartbeatMs: 50 },
    );
    await engine1.init();
    await engine1.start();
    await engine1.pauseWorker("survive-restart");
    await engine1.stop();

    // Second engine instance — should load paused state from storage
    const engine2 = new WorkerEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "worker", heartbeatMs: 50 },
    );
    await engine2.init();

    const state = engine2.getWorkerState("survive-restart");
    expect(state?.enabled).toBe(false);

    await engine2.stop();
  });

  it("paused worker does not claim new jobs", async () => {
    let handlerCalled = false;
    worker<{ x: number }>({
      topic: "no-claim-paused",
      handler: async () => {
        handlerCalled = true;
        return "ok";
      },
    });

    const pub = queue<{ x: number }>({ name: "no-claim-paused" });

    const engine = new WorkerEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "worker", heartbeatMs: 50 },
    );
    await engine.init();
    await engine.start();

    await engine.pauseWorker("no-claim-paused");
    await pub.add({ x: 1 });

    await new Promise((r) => setTimeout(r, 300));
    expect(handlerCalled).toBe(false);

    await engine.stop();
  });
});
