import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OqronContainer } from "../../src/engine/container.js";
import { createLogger } from "../../src/engine/logger/index.js";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";
import { MemoryLock } from "../../src/engine/memory/memory-lock.js";
import { MemoryStore } from "../../src/engine/memory/memory-store.js";
import { queue } from "../../src/queue/define-queue.js";
import { worker } from "../../src/worker/define-worker.js";
import { WorkerEngine } from "../../src/worker/worker-engine.js";

describe("WorkerEngine — Environment Isolation", () => {
  const logger = createLogger({ enabled: false }, { module: "test" });

  beforeEach(() => {
    OqronContainer.init(new MemoryStore(), new MemoryBroker(), new MemoryLock(), {
      project: "test",
      environment: "production",
    });
  });

  afterEach(() => {
    OqronContainer.reset();
  });

  it("nacks jobs from a different environment", async () => {
    let processed = false;

    worker<{ x: number }>({
      topic: "env-topic",
      handler: async () => {
        processed = true;
      },
    });

    // Add a job with a different environment
    const pub = queue<{ x: number }>({ name: "env-topic" });
    const job = await pub.add({ x: 1 });

    // Manually set the job's environment to staging
    const di = OqronContainer.get();
    const savedJob = await di.storage.get<any>("jobs", job.id);
    savedJob.environment = "staging";
    await di.storage.save("jobs", job.id, savedJob);

    const engine = new WorkerEngine(
      { project: "test", environment: "production" },
      logger,
      { module: "worker", heartbeatMs: 50 },
    );
    await engine.start();
    await new Promise((r) => setTimeout(r, 300));
    await engine.stop();

    // Job should NOT have been processed because environment doesn't match
    expect(processed).toBe(false);
  });

  it("processes jobs from the matching environment", async () => {
    let processed = false;

    worker<{ x: number }>({
      topic: "env-match-topic",
      handler: async () => {
        processed = true;
      },
    });

    const pub = queue<{ x: number }>({ name: "env-match-topic" });
    await pub.add({ x: 1 });

    const engine = new WorkerEngine(
      { project: "test", environment: "production" },
      logger,
      { module: "worker", heartbeatMs: 50 },
    );
    await engine.start();
    await new Promise((r) => setTimeout(r, 300));
    await engine.stop();

    expect(processed).toBe(true);
  });
});
