import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OqronContainer } from "../../src/engine/container.js";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";
import { MemoryLock } from "../../src/engine/memory/memory-lock.js";
import { MemoryStore } from "../../src/engine/memory/memory-store.js";
import { OqronKit } from "../../src/index.js";
import { queue } from "../../src/queue/define-queue.js";
import { QueueEngine } from "../../src/queue/queue-engine.js";
import { getRegisteredQueues } from "../../src/queue/registry.js";
import { createLogger } from "../../src/engine/logger/index.js";
import type { IPublisherQueue } from "../../src/queue/types.js";

describe("Publisher-Only Queue (no handler)", () => {
  beforeEach(() => {
    const store = new MemoryStore();
    const broker = new MemoryBroker();
    const lock = new MemoryLock();
    OqronContainer.init(store, broker, lock, {
      project: "test",
      environment: "test",
    });
  });

  afterEach(() => {
    OqronContainer.reset();
  });

  it("should create a queue without handler and return IPublisherQueue", () => {
    const pubQueue = queue<{ url: string }>({ name: "video-encode" });

    expect(pubQueue).toBeDefined();
    expect(pubQueue.name).toBe("video-encode");
    expect(typeof pubQueue.add).toBe("function");
  });

  it("should push jobs to Storage via .add() without a handler present", async () => {
    const pubQueue = queue<{ url: string }>({ name: "pub-test" });

    const job = await pubQueue.add({ url: "https://example.com/video.mp4" });

    expect(job).toBeDefined();
    expect(job.id).toBeDefined();
    expect(job.status).toBe("waiting");
    expect(job.data.url).toBe("https://example.com/video.mp4");
    expect(job.queueName).toBe("pub-test");

    // Verify persisted in storage
    const di = OqronContainer.get();
    const stored = await di.storage.get<any>("jobs", job.id);
    expect(stored).toBeDefined();
    expect(stored!.status).toBe("waiting");
  });

  it("should publish job IDs to the broker for later consumption", async () => {
    const pubQueue = queue<{ msg: string }>({ name: "broker-test" });
    const di = OqronContainer.get();

    await pubQueue.add({ msg: "hello" });

    // The broker should have the job ID available for claiming
    const claimed = await di.broker.claim("broker-test", "worker-1", 1, 30000);
    expect(claimed).toHaveLength(1);
  });

  it("should support delayed jobs in publisher-only mode", async () => {
    const pubQueue = queue<{ item: string }>({ name: "delayed-pub" });

    const job = await pubQueue.add({ item: "delayed" }, { delay: 5000 });

    expect(job.status).toBe("delayed");
    expect(job.runAt).toBeDefined();
  });

  it("should support priority in publisher-only mode", async () => {
    const pubQueue = queue<{ item: string }>({ name: "priority-pub" });

    const job = await pubQueue.add({ item: "urgent" }, { priority: 1 });

    expect(job.opts.priority).toBe(1);
  });

  it("should support custom jobId for idempotency in publisher-only mode", async () => {
    const pubQueue = queue<{ data: number }>({ name: "idem-pub" });

    const job = await pubQueue.add({ data: 42 }, { jobId: "my-unique-key" });

    expect(job.id).toBe("my-unique-key");
  });

  it("rejects duplicate custom job IDs instead of overwriting persisted jobs", async () => {
    const pubQueue = queue<{ data: number }>({ name: "idem-reject-pub" });

    await pubQueue.add({ data: 1 }, { jobId: "dup-key" });

    await expect(
      pubQueue.add({ data: 2 }, { jobId: "dup-key" }),
    ).rejects.toThrow("already exists");
  });

  it("rejects dependencies on missing parent jobs", async () => {
    const pubQueue = queue<{ data: number }>({ name: "missing-parent-pub" });

    await expect(
      pubQueue.add({ data: 1 }, { dependsOn: ["missing-parent"] }),
    ).rejects.toThrow("Missing dependency parent");
  });

  it("QueueEngine should NOT start polling for handler-less queues", async () => {
    // Register a publisher-only queue
    queue<{ x: number }>({ name: "no-poll-queue" });

    const logger = createLogger({ enabled: true, level: "info" }, { module: "test" });
    const engine = new QueueEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "queue", heartbeatMs: 50 },
    );

    await engine.init();
    await engine.start();

    // Push a job — it should sit in the broker unclaimed because no one is polling
    const di = OqronContainer.get();
    const pubQueue = queue<{ x: number }>({ name: "no-poll-queue" });
    await pubQueue.add({ x: 1 });

    // Wait longer than heartbeat interval
    await new Promise((r) => setTimeout(r, 200));

    // The job should still be in "waiting" status — no worker picked it up
    const jobs = await di.storage.list<any>("jobs", { queueName: "no-poll-queue" });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("waiting");

    await engine.stop();
  });

  it("QueueEngine should still poll queues WITH handlers alongside handler-less ones", async () => {
    let handlerCalled = false;

    // One with handler, one without
    queue<{ x: number }>({ name: "has-handler", handler: async () => { handlerCalled = true; } });
    queue<{ y: number }>({ name: "no-handler" });

    const logger = createLogger({ enabled: true, level: "info" }, { module: "test" });
    const engine = new QueueEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "queue", heartbeatMs: 50 },
    );

    await engine.init();
    await engine.start();

    // Push a job to the queue WITH a handler
    const withHandler = queue<{ x: number }>({
      name: "has-handler",
      handler: async () => { handlerCalled = true; },
    });
    await withHandler.add({ x: 1 });

    // Wait for processing
    await new Promise((r) => setTimeout(r, 300));

    expect(handlerCalled).toBe(true);

    await engine.stop();
  });
});
