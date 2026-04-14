import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OqronContainer } from "../../src/engine/container.js";
import { createLogger } from "../../src/engine/logger/index.js";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";
import { MemoryLock } from "../../src/engine/memory/memory-lock.js";
import { MemoryStore } from "../../src/engine/memory/memory-store.js";
import { queue } from "../../src/queue/define-queue.js";
import { worker } from "../../src/worker/define-worker.js";
import { WorkerEngine } from "../../src/worker/worker-engine.js";

describe("Distributed Worker (Consumer-Only)", () => {
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

  it("should create a worker and return an IWorker without `.add`", () => {
    const myWorker = worker<{ x: string }>({
      topic: "test-topic",
      handler: async () => {},
    });

    expect(myWorker).toBeDefined();
    expect(myWorker.topic).toBe("test-topic");
    // Explicitly verify `.add` does NOT exist
    expect((myWorker as any).add).toBeUndefined();
  });

  it("should process jobs pushed to its topic by a publisher-only queue", async () => {
    let processedUrl = "";

    // 1. Publisher pushes a job
    const videoQueue = queue<{ url: string }>({ name: "video-encode" });
    await videoQueue.add({ url: "https://example.com/movie.mp4" });

    // 2. Worker is registered to consume from that topic
    worker<{ url: string }>({
      topic: "video-encode",
      handler: async (ctx) => {
        processedUrl = ctx.data.url;
      },
    });

    // 3. Start worker engine
    const logger = createLogger({ enabled: true, level: "info" }, { module: "test" });
    const engine = new WorkerEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "worker", heartbeatMs: 50 },
    );

    await engine.init();
    await engine.start();

    // 4. Wait for processing cycle
    await new Promise((r) => setTimeout(r, 200));

    expect(processedUrl).toBe("https://example.com/movie.mp4");

    await engine.stop();
  });

  it("should enforce worker concurrency limits", async () => {
    let activeExecutions = 0;
    let maxObserved = 0;

    worker<{ x: number }>({
      topic: "parallel-topic",
      concurrency: 2, // Strict limit of 2 concurrent executions
      handler: async () => {
        activeExecutions++;
        maxObserved = Math.max(maxObserved, activeExecutions);
        await new Promise((r) => setTimeout(r, 100)); // occupy worker
        activeExecutions--;
      },
    });

    const pubQueue = queue<{ x: number }>({ name: "parallel-topic" });

    // Push 5 jobs rapidly
    await Promise.all([
      pubQueue.add({ x: 1 }),
      pubQueue.add({ x: 2 }),
      pubQueue.add({ x: 3 }),
      pubQueue.add({ x: 4 }),
      pubQueue.add({ x: 5 }),
    ]);

    const logger = createLogger({ enabled: false }, { module: "test" });
    const engine = new WorkerEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "worker", heartbeatMs: 50 },
    );

    await engine.start();
    await new Promise((r) => setTimeout(r, 500));
    await engine.stop();

    expect(maxObserved).toBeLessThanOrEqual(2);
    expect(maxObserved).toBeGreaterThan(0); // Make sure it actually ran
  });

  it("should implement crash-safety via HeartbeatWorker locks", async () => {
    worker<{ x: number }>({
      topic: "crash-test",
      handler: async () => {
        await new Promise((r) => setTimeout(r, 1000));
      },
    });

    const pubQueue = queue<{ x: number }>({ name: "crash-test" });
    const job = await pubQueue.add({ x: 1 });

    const logger = createLogger({ enabled: false }, { module: "test" });
    const engine = new WorkerEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "worker", heartbeatMs: 50 },
    );

    await engine.start();
    await new Promise((r) => setTimeout(r, 100)); // Let it claim the job

    const di = OqronContainer.get();
    const isLocked = await di.lock.isOwner(`worker:job:${job.id}`, (engine as any).workerIdStr);
    expect(isLocked).toBe(true);

    await engine.stop();
  });
});
