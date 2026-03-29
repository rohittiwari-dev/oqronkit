import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { OqronKit, Queue, Worker } from "../../src/index.js";
import { OqronRegistry } from "../../src/core/index.js";
import { MemoryAdapter } from "../../src/adapters/memory.adapter.js";

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

    // 3. Inject manual test adapter (Unified Model)
    const adapter = new MemoryAdapter();
    
    // Boot OqronKit with DI instances
    await OqronKit.init({
      config: {
        environment: "test",
        project: "test-proj",
        modules: ["worker"],
        db: adapter,
        broker: adapter,
      },
    });

    await publisherQueue.add("test-job", { msg: "Hello from Publisher" });

    // Advance Timers to trigger the engine tick natively
    await vi.advanceTimersByTimeAsync(200);

    expect(executed).toBe(true);
    expect(payloadStr).toBe("Hello from Publisher");
  });
});
