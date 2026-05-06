import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OqronContainer } from "../../src/engine/container.js";
import { createLogger } from "../../src/engine/logger/index.js";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";
import { MemoryLock } from "../../src/engine/memory/memory-lock.js";
import { MemoryStore } from "../../src/engine/memory/memory-store.js";
import { queue } from "../../src/queue/define-queue.js";
import { QueueEngine } from "../../src/queue/queue-engine.js";

describe("QueueEngine — Environment Isolation", () => {
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

  it("nacks jobs from a mismatched environment", async () => {
    let processed = false;

    const q = queue<{ x: number }>({
      name: "q-env-mismatch",
      handler: async () => {
        processed = true;
      },
    });

    const job = await q.add({ x: 1 });

    // Manually set the job's environment to staging
    const di = OqronContainer.get();
    const savedJob = await di.storage.get<any>("jobs", job.id);
    savedJob.environment = "staging";
    await di.storage.save("jobs", job.id, savedJob);

    const engine = new QueueEngine(
      { project: "test", environment: "production" },
      logger,
      { module: "queue", heartbeatMs: 50 },
    );
    await engine.init();
    await engine.start();
    await new Promise((r) => setTimeout(r, 300));
    await engine.stop();

    expect(processed).toBe(false);
  });

  it("processes jobs with matching environment", async () => {
    let processed = false;

    const q = queue<{ x: number }>({
      name: "q-env-match",
      handler: async () => {
        processed = true;
      },
    });

    await q.add({ x: 1 });

    const engine = new QueueEngine(
      { project: "test", environment: "production" },
      logger,
      { module: "queue", heartbeatMs: 50 },
    );
    await engine.init();
    await engine.start();
    await new Promise((r) => setTimeout(r, 300));
    await engine.stop();

    expect(processed).toBe(true);
  });
});
