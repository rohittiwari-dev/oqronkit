import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OqronContainer } from "../../src/engine/container.js";
import { createLogger } from "../../src/engine/logger/index.js";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";
import { MemoryLock } from "../../src/engine/memory/memory-lock.js";
import { MemoryStore } from "../../src/engine/memory/memory-store.js";
import { queue } from "../../src/queue/define-queue.js";
import { QueueEngine } from "../../src/queue/queue-engine.js";

describe("QueueEngine — DLQ Handler", () => {
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

  it("invokes DLQ handler after all retries are exhausted", async () => {
    let dlqCalled = false;
    let dlqJob: any = null;

    const q = queue<{ x: number }>({
      name: "q-dlq",
      retries: { max: 1, strategy: "fixed", baseDelay: 50 },
      deadLetter: {
        enabled: true,
        onDead: async (job) => {
          dlqCalled = true;
          dlqJob = job;
        },
      },
      handler: async () => {
        throw new Error("Permanent failure");
      },
    });

    await q.add({ x: 42 });

    const engine = new QueueEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "queue", heartbeatMs: 50 },
    );
    await engine.init();
    await engine.start();
    // Allow time for initial attempt + 1 retry + DLQ trigger
    await new Promise((r) => setTimeout(r, 1200));
    await engine.stop();

    expect(dlqCalled).toBe(true);
    expect(dlqJob).toBeDefined();
    expect(dlqJob.data.x).toBe(42);
  });

  it("DLQ handler receives the failed job with error information", async () => {
    let capturedError = "";

    const q = queue<{ x: number }>({
      name: "q-dlq-error",
      retries: { max: 0 }, // No retries — straight to DLQ
      deadLetter: {
        enabled: true,
        onDead: async (job) => {
          capturedError = job.error ?? "";
        },
      },
      handler: async () => {
        throw new Error("Specific failure reason");
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

    expect(capturedError).toContain("Specific failure reason");
  });
});
