import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { OqronKit, Queue, Worker } from "../../src/index.js";
import { OqronRegistry } from "../../src/core/index.js";
import { MemoryQueueAdapter } from "../../src/queue/adapters/memory-queue.js";

describe("Server-Independent module: Distributed Worker", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await OqronKit.stop();
    OqronRegistry.getInstance()._reset();
  });

  it("should process jobs seamlessly via fully decoupled publishers and consumers", async () => {
    let executed = false;
    let payloadStr = "";

    // 1. App Node strictly defines Publisher (no background polling)
    const publisherQueue = new Queue<{ msg: string }>("decoupled-queue");

    // 2. Worker Node strictly defines Processor
    const consumerWorker = new Worker("decoupled-queue", async (job) => {
      executed = true;
      payloadStr = job.data.msg;
      return true;
    });

    // Boot OqronKit to wire up standard memory adapter for tests natively
    await OqronKit.init({
      config: {
        environment: "test",
        project: "test-proj",
        modules: ["worker"],
      },
    });

    // Inject manual test adapter
    const adapter = new MemoryQueueAdapter();
    (publisherQueue as any).options = { ...((publisherQueue as any).options || {}), connection: adapter };
    (consumerWorker as any).options = { ...(consumerWorker.options || {}), connection: adapter };

    await publisherQueue.add("test-job", { msg: "Hello from Publisher" });

    // Advance Timers to trigger the engine tick natively
    await vi.advanceTimersByTimeAsync(200);

    expect(executed).toBe(true);
    expect(payloadStr).toBe("Hello from Publisher");
  });

  it("should enforce max limit on active items", async () => {
    let active = 0;
    let maxFound = 0;

    const myWorker = new Worker(
      "limit-q",
      async () => {
        active++;
        maxFound = Math.max(maxFound, active);
        await new Promise((r) => setTimeout(r, 50));
        active--;
      },
      { concurrency: 2 },
    );

    const publisher = new Queue("limit-q");

    await OqronKit.init({
      config: { environment: "test", modules: ["worker"] },
    });

    const adapter = new MemoryQueueAdapter();
    (publisher as any).options = { ...((publisher as any).options || {}), connection: adapter };
    (myWorker as any).options = { ...(myWorker.options || {}), connection: adapter };

    // Spiky payload
    await publisher.addBulk([
      { name: "j1", data: {} },
      { name: "j2", data: {} },
      { name: "j3", data: {} },
      { name: "j4", data: {} },
    ]);

    await vi.advanceTimersByTimeAsync(200);

    expect(maxFound).toBe(2);
    expect(active).toBe(0);
  });
});
