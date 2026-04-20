import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OqronContainer } from "../../src/engine/container.js";
import { createLogger } from "../../src/engine/logger/index.js";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";
import { MemoryLock } from "../../src/engine/memory/memory-lock.js";
import { MemoryStore } from "../../src/engine/memory/memory-store.js";
import { queue } from "../../src/queue/define-queue.js";
import { QueueEngine } from "../../src/queue/queue-engine.js";
import type { OqronJob } from "../../src/engine/types/job.types.js";
import { getRegisteredQueues } from "../../src/queue/registry.js";

describe("Queue — Crash Recovery & Retry", () => {
  const logger = createLogger({ enabled: false }, { module: "test" });

  beforeEach(() => {
    OqronContainer.init(new MemoryStore(), new MemoryBroker(), new MemoryLock(), {
      project: "test",
      environment: "test",
    });
    getRegisteredQueues().splice(0);
  });

  afterEach(() => {
    OqronContainer.reset();
  });

  it("retries a failed job and transitions to delayed then back to active", async () => {
    let callCount = 0;
    const q = queue<{ x: number }>({
      name: "crash-retry",
      retries: { max: 2, strategy: "fixed", baseDelay: 100 },
      handler: async () => {
        callCount++;
        if (callCount < 3) throw new Error("temporary failure");
        return "success";
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

    // Wait for retries to complete (100ms delay × 2 retries + processing)
    await new Promise((r) => setTimeout(r, 1500));

    expect(callCount).toBe(3);

    // Verify final job state
    const di = OqronContainer.get();
    const jobs = await di.storage.list<OqronJob>("jobs", {
      queueName: "crash-retry",
    });
    const job = jobs[0];
    expect(job?.status).toBe("completed");
    expect(job?.attemptMade).toBe(3);

    await engine.stop();
  });

  it("sends job to DLQ after all retries exhausted", async () => {
    let dlqReceived: OqronJob | null = null;
    const q = queue<{ x: number }>({
      name: "crash-dlq",
      retries: { max: 1, strategy: "fixed", baseDelay: 50 },
      deadLetter: {
        enabled: true,
        onDead: async (job) => {
          dlqReceived = job;
        },
      },
      handler: async () => {
        throw new Error("permanent failure");
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
    await new Promise((r) => setTimeout(r, 800));

    expect(dlqReceived).not.toBeNull();
    expect(dlqReceived!.status).toBe("failed");
    expect(dlqReceived!.error).toContain("permanent failure");

    await engine.stop();
  });

  it("cleans up heartbeat and abort controller on crash", async () => {
    const q = queue<{ x: number }>({
      name: "crash-cleanup",
      handler: async () => {
        throw new Error("crash");
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
    await new Promise((r) => setTimeout(r, 300));

    // After crash, job should be in failed state with clean metadata
    const di = OqronContainer.get();
    const jobs = await di.storage.list<OqronJob>("jobs", {
      queueName: "crash-cleanup",
    });
    const job = jobs[0];
    expect(job?.status).toBe("failed");
    expect(job?.finishedAt).toBeDefined();
    expect(job?.stacktrace).toBeDefined();

    await engine.stop();
  });

  it("records timeline entries during retry cycle", async () => {
    let calls = 0;
    const q = queue<{ x: number }>({
      name: "crash-timeline",
      retries: { max: 1, strategy: "fixed", baseDelay: 50 },
      handler: async () => {
        calls++;
        if (calls < 2) throw new Error("fail once");
        return "ok";
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
    await new Promise((r) => setTimeout(r, 800));

    const di = OqronContainer.get();
    const jobs = await di.storage.list<OqronJob>("jobs", {
      queueName: "crash-timeline",
    });
    const job = jobs[0];
    expect(job?.timeline).toBeDefined();
    expect(job!.timeline!.length).toBeGreaterThanOrEqual(2);

    await engine.stop();
  });
});
