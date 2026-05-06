import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OqronContainer } from "../../src/engine/container.js";
import { createLogger } from "../../src/engine/logger/index.js";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";
import { MemoryLock } from "../../src/engine/memory/memory-lock.js";
import { MemoryStore } from "../../src/engine/memory/memory-store.js";
import { queue } from "../../src/queue/define-queue.js";
import { worker } from "../../src/worker/define-worker.js";
import { WorkerEngine } from "../../src/worker/worker-engine.js";
import type { OqronJob } from "../../src/engine/types/job.types.js";

describe("WorkerEngine — cancelActiveJob (B6)", () => {
  const logger = createLogger({ enabled: false }, { module: "test" });

  beforeEach(() => {
    OqronContainer.init(new MemoryStore(), new MemoryBroker(), new MemoryLock(), { project: "test", environment: "test" });
  });

  afterEach(() => { OqronContainer.reset(); });

  it("cancels a running job and marks it cancelled", async () => {
    let jobId = "";
    worker<{ x: number }>({
      topic: "cancel-topic",
      handler: async (ctx) => {
        jobId = ctx.id;
        // Long-running job
        await new Promise((r) => setTimeout(r, 5000));
      },
    });

    const pub = queue<{ x: number }>({ name: "cancel-topic" });
    const job = await pub.add({ x: 1 });

    const engine = new WorkerEngine(
      { project: "test", environment: "test" }, logger,
      { module: "worker", heartbeatMs: 50 },
    );
    await engine.start();
    await new Promise((r) => setTimeout(r, 150)); // Let it claim

    const cancelled = await engine.cancelActiveJob(job.id);
    expect(cancelled).toBe(true);

    // Verify job is marked cancelled in storage
    const di = OqronContainer.get();
    const updated = await di.storage.get<OqronJob>("jobs", job.id);
    expect(updated?.status).toBe("cancelled");
    expect(updated?.error).toBe("Cancelled");

    await engine.stop();
  });

  it("returns false for non-active jobs", async () => {
    const engine = new WorkerEngine(
      { project: "test", environment: "test" }, logger,
      { module: "worker", heartbeatMs: 50 },
    );
    await engine.start();

    const result = await engine.cancelActiveJob("non-existent-id");
    expect(result).toBe(false);

    await engine.stop();
  });
});
