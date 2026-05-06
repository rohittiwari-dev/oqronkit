import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OqronContainer } from "../../src/engine/container.js";
import { createLogger } from "../../src/engine/logger/index.js";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";
import { MemoryLock } from "../../src/engine/memory/memory-lock.js";
import { MemoryStore } from "../../src/engine/memory/memory-store.js";
import { queue } from "../../src/queue/define-queue.js";
import { worker } from "../../src/worker/define-worker.js";
import { WorkerEngine } from "../../src/worker/worker-engine.js";

describe("WorkerEngine — Timeout Enforcement", () => {
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

  it("aborts a job that exceeds timeout", async () => {
    let wasAborted = false;

    worker<{ x: number }>({
      topic: "timeout-topic",
      timeout: 100, // 100ms timeout
      handler: async (ctx) => {
        // Listen for abort
        ctx.signal.addEventListener("abort", () => {
          wasAborted = true;
        });
        // Simulate slow work — longer than timeout
        await new Promise((r) => setTimeout(r, 1000));
      },
    });

    const pub = queue<{ x: number }>({ name: "timeout-topic" });
    const job = await pub.add({ x: 1 });

    const engine = new WorkerEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "worker", heartbeatMs: 50 },
    );
    await engine.start();
    await new Promise((r) => setTimeout(r, 500));
    await engine.stop();

    expect(wasAborted).toBe(true);

    // Verify job is marked as failed
    const di = OqronContainer.get();
    const finalJob = await di.storage.get<any>("jobs", job.id);
    expect(finalJob.status).toBe("failed");
    expect(finalJob.error).toContain("timeout");
  });

  it("successful job within timeout completes normally", async () => {
    let completed = false;

    worker<{ x: number }>({
      topic: "no-timeout-topic",
      timeout: 5000, // Large timeout
      handler: async () => {
        await new Promise((r) => setTimeout(r, 10));
        completed = true;
      },
    });

    const pub = queue<{ x: number }>({ name: "no-timeout-topic" });
    const job = await pub.add({ x: 1 });

    const engine = new WorkerEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "worker", heartbeatMs: 50 },
    );
    await engine.start();
    await new Promise((r) => setTimeout(r, 300));
    await engine.stop();

    expect(completed).toBe(true);

    const di = OqronContainer.get();
    const finalJob = await di.storage.get<any>("jobs", job.id);
    expect(finalJob.status).toBe("completed");
  });
});
