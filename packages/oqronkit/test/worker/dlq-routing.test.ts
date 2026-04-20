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

describe("WorkerEngine — DLQ Routing", () => {
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

  it("invokes onDead hook when all retries are exhausted", async () => {
    let deadJob: OqronJob | null = null;
    worker<{ x: number }>({
      topic: "dlq-topic",
      retries: { max: 1, strategy: "fixed", baseDelay: 50 },
      deadLetter: {
        enabled: true,
        onDead: async (job) => {
          deadJob = job;
        },
      },
      handler: async () => {
        throw new Error("always fails");
      },
    });

    const pub = queue<{ x: number }>({ name: "dlq-topic" });
    await pub.add({ x: 1 });

    const engine = new WorkerEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "worker", heartbeatMs: 50 },
    );
    await engine.init();
    await engine.start();
    await new Promise((r) => setTimeout(r, 800));

    expect(deadJob).not.toBeNull();
    expect(deadJob!.status).toBe("failed");
    expect(deadJob!.error).toContain("always fails");

    await engine.stop();
  });

  it("does NOT invoke onDead for jobs that succeed", async () => {
    let deadCalled = false;
    worker<{ x: number }>({
      topic: "dlq-success",
      deadLetter: {
        enabled: true,
        onDead: async () => {
          deadCalled = true;
        },
      },
      handler: async () => "ok",
    });

    const pub = queue<{ x: number }>({ name: "dlq-success" });
    await pub.add({ x: 1 });

    const engine = new WorkerEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "worker", heartbeatMs: 50 },
    );
    await engine.init();
    await engine.start();
    await new Promise((r) => setTimeout(r, 300));

    expect(deadCalled).toBe(false);

    await engine.stop();
  });

  it("does NOT invoke onDead for cancelled jobs", async () => {
    let deadCalled = false;
    worker<{ x: number }>({
      topic: "dlq-cancel",
      deadLetter: {
        enabled: true,
        onDead: async () => {
          deadCalled = true;
        },
      },
      handler: async (ctx) => {
        await new Promise((r) => setTimeout(r, 5000));
      },
    });

    const pub = queue<{ x: number }>({ name: "dlq-cancel" });
    const job = await pub.add({ x: 1 });

    const engine = new WorkerEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "worker", heartbeatMs: 50 },
    );
    await engine.init();
    await engine.start();
    await new Promise((r) => setTimeout(r, 150));

    await engine.cancelActiveJob(job.id);
    await new Promise((r) => setTimeout(r, 200));

    expect(deadCalled).toBe(false);

    await engine.stop();
  });
});
