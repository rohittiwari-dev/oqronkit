import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OqronContainer } from "../../src/engine/container.js";
import { createLogger } from "../../src/engine/logger/index.js";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";
import { MemoryLock } from "../../src/engine/memory/memory-lock.js";
import { MemoryStore } from "../../src/engine/memory/memory-store.js";
import { queue } from "../../src/queue/define-queue.js";
import { worker } from "../../src/worker/define-worker.js";
import { WorkerEngine } from "../../src/worker/worker-engine.js";

describe("WorkerEngine — Disabled Behavior", () => {
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

  it("skips processing when worker is disabled", async () => {
    let processed = false;

    worker<{ x: number }>({
      topic: "disabled-skip-topic",
      handler: async () => {
        processed = true;
      },
    });

    const pub = queue<{ x: number }>({ name: "disabled-skip-topic" });
    await pub.add({ x: 1 });

    const engine = new WorkerEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "worker", heartbeatMs: 50 },
    );
    await engine.init();

    // Disable the engine before starting
    await engine.disable();
    await engine.start();
    await new Promise((r) => setTimeout(r, 300));
    await engine.stop();

    // Job should NOT be processed because the engine is disabled
    expect(processed).toBe(false);
  });

  it("resumes processing after re-enabling worker engine", async () => {
    let processed = false;

    worker<{ x: number }>({
      topic: "reenable-topic",
      handler: async () => {
        processed = true;
      },
    });

    const pub = queue<{ x: number }>({ name: "reenable-topic" });
    await pub.add({ x: 1 });

    const engine = new WorkerEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "worker", heartbeatMs: 50 },
    );
    await engine.init();
    await engine.disable();
    await engine.start();
    await new Promise((r) => setTimeout(r, 100));

    // Re-enable
    await engine.enable();
    await new Promise((r) => setTimeout(r, 400));
    await engine.stop();

    expect(processed).toBe(true);
  });

  it("does not skip jobs just because enabled worker config uses disabledBehavior=skip", async () => {
    let processed = false;

    worker<{ x: number }>({
      topic: "enabled-skip-policy-topic",
      disabledBehavior: "skip",
      handler: async () => {
        processed = true;
      },
    });

    const pub = queue<{ x: number }>({ name: "enabled-skip-policy-topic" });
    const job = await pub.add({ x: 1 });

    const engine = new WorkerEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "worker", heartbeatMs: 50 },
    );
    await engine.init();
    await engine.start();
    await new Promise((r) => setTimeout(r, 300));
    await engine.stop();

    const stored = await OqronContainer.get().storage.get<any>("jobs", job.id);
    expect(processed).toBe(true);
    expect(stored?.status).toBe("completed");
  });
});
