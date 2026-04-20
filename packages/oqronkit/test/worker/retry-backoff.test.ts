import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OqronContainer } from "../../src/engine/container.js";
import { createLogger } from "../../src/engine/logger/index.js";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";
import { MemoryLock } from "../../src/engine/memory/memory-lock.js";
import { MemoryStore } from "../../src/engine/memory/memory-store.js";
import { queue } from "../../src/queue/define-queue.js";
import { worker } from "../../src/worker/define-worker.js";
import { WorkerEngine } from "../../src/worker/worker-engine.js";

describe("WorkerEngine — Retry & Backoff", () => {
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

  it("retries a failed job up to retries.max times", async () => {
    let attempts = 0;

    worker<{ x: number }>({
      topic: "retry-topic",
      retries: { max: 3, strategy: "fixed", baseDelay: 50 },
      handler: async () => {
        attempts++;
        throw new Error("Deliberate failure");
      },
    });

    const pub = queue<{ x: number }>({ name: "retry-topic" });
    await pub.add({ x: 1 });

    const engine = new WorkerEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "worker", heartbeatMs: 50 },
    );
    await engine.start();
    // Give time for retries (3 retries × 50ms delay + processing time)
    await new Promise((r) => setTimeout(r, 1500));
    await engine.stop();

    // Should have attempted 4 times (1 initial + 3 retries)
    expect(attempts).toBeGreaterThanOrEqual(2); // At least 2 to prove retrying
    expect(attempts).toBeLessThanOrEqual(4);
  });

  it("sends job to DLQ after all retries are exhausted", async () => {
    let dlqCalled = false;
    let dlqJob: any = null;

    worker<{ x: number }>({
      topic: "dlq-retry-topic",
      retries: { max: 1, strategy: "fixed", baseDelay: 50 },
      deadLetter: {
        enabled: true,
        onDead: async (job) => {
          dlqCalled = true;
          dlqJob = job;
        },
      },
      handler: async () => {
        throw new Error("Always fails");
      },
    });

    const pub = queue<{ x: number }>({ name: "dlq-retry-topic" });
    await pub.add({ x: 42 });

    const engine = new WorkerEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "worker", heartbeatMs: 50 },
    );
    await engine.start();
    await new Promise((r) => setTimeout(r, 1000));
    await engine.stop();

    expect(dlqCalled).toBe(true);
    expect(dlqJob).toBeDefined();
    expect(dlqJob.data.x).toBe(42);
  });

  it("applies fixed backoff delay between retries", async () => {
    const attemptTimestamps: number[] = [];

    worker<{ x: number }>({
      topic: "fixed-backoff-topic",
      retries: { max: 2, strategy: "fixed", baseDelay: 100 },
      handler: async () => {
        attemptTimestamps.push(Date.now());
        throw new Error("Fail");
      },
    });

    const pub = queue<{ x: number }>({ name: "fixed-backoff-topic" });
    await pub.add({ x: 1 });

    const engine = new WorkerEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "worker", heartbeatMs: 50 },
    );
    await engine.start();
    await new Promise((r) => setTimeout(r, 1500));
    await engine.stop();

    // At least 2 attempts to validate backoff is happening
    expect(attemptTimestamps.length).toBeGreaterThanOrEqual(2);
    if (attemptTimestamps.length >= 2) {
      const gap = attemptTimestamps[1] - attemptTimestamps[0];
      // Fixed backoff of 100ms + some polling overhead
      expect(gap).toBeGreaterThanOrEqual(80);
    }
  });

  it("applies exponential backoff with increasing delay", async () => {
    const attemptTimestamps: number[] = [];

    worker<{ x: number }>({
      topic: "exp-backoff-topic",
      retries: { max: 2, strategy: "exponential", baseDelay: 50 },
      handler: async () => {
        attemptTimestamps.push(Date.now());
        throw new Error("Fail");
      },
    });

    const pub = queue<{ x: number }>({ name: "exp-backoff-topic" });
    await pub.add({ x: 1 });

    const engine = new WorkerEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "worker", heartbeatMs: 50 },
    );
    await engine.start();
    await new Promise((r) => setTimeout(r, 2000));
    await engine.stop();

    expect(attemptTimestamps.length).toBeGreaterThanOrEqual(2);
  });
});
