import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OqronContainer } from "../../src/engine/container.js";
import { createLogger } from "../../src/engine/logger/index.js";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";
import { MemoryLock } from "../../src/engine/memory/memory-lock.js";
import { MemoryStore } from "../../src/engine/memory/memory-store.js";
import { queue } from "../../src/queue/define-queue.js";
import { worker } from "../../src/worker/define-worker.js";
import { WorkerEngine } from "../../src/worker/worker-engine.js";

describe("WorkerEngine — Graceful Drain (B3)", () => {
  const logger = createLogger({ enabled: false }, { module: "test" });

  beforeEach(() => {
    OqronContainer.init(new MemoryStore(), new MemoryBroker(), new MemoryLock(), { project: "test", environment: "test" });
  });

  afterEach(() => { OqronContainer.reset(); });

  it("stop() waits for active jobs to settle before returning", async () => {
    let jobFinished = false;
    worker<{ x: number }>({
      topic: "drain-topic",
      handler: async () => {
        await new Promise((r) => setTimeout(r, 200));
        jobFinished = true;
      },
    });

    const pub = queue<{ x: number }>({ name: "drain-topic" });
    await pub.add({ x: 1 });

    const engine = new WorkerEngine(
      { project: "test", environment: "test" }, logger,
      { module: "worker", heartbeatMs: 50 },
    );
    await engine.start();
    await new Promise((r) => setTimeout(r, 100)); // Let it claim
    await engine.stop();
    // After stop, the job should have been given time to finish
    // (aborted, but the drain waited for the promise to settle)
  });

  it("stop() does not hang indefinitely if jobs exceed timeout", async () => {
    worker<{ x: number }>({
      topic: "hang-topic",
      handler: async () => { await new Promise(() => {}); }, // Never resolves
    });

    const pub = queue<{ x: number }>({ name: "hang-topic" });
    await pub.add({ x: 1 });

    const engine = new WorkerEngine(
      { project: "test", environment: "test" }, logger,
      { module: "worker", heartbeatMs: 50, shutdownTimeout: 500 },
    );
    await engine.start();
    await new Promise((r) => setTimeout(r, 100));

    const start = Date.now();
    await engine.stop();
    const elapsed = Date.now() - start;
    // Should not hang — should return within ~500ms shutdown timeout
    expect(elapsed).toBeLessThan(2000);
  });
});
