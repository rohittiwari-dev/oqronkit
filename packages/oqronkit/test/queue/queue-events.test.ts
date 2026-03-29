import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { OqronKit, QueueEvents, taskQueue } from "../../src/index.js";
import { OqronRegistry } from "../../src/engine/index.js";

describe("Server-Independent module: QueueEvents (Observability)", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await OqronKit.stop();
    OqronRegistry.getInstance()._reset();
  });

  it("should natively surface execution traces explicitly targeting specific queue telemetry", async () => {
    let completedFired = 0;
    
    // Target specific queue stream
    const watcher = new QueueEvents("telemetry-queue");
    watcher.on("completed", ({ jobId, returnvalue }) => {
      completedFired++;
      expect(returnvalue).toBe("my payload response");
      expect(jobId).toBeDefined();
    });

    const activeQ = taskQueue({
      name: "telemetry-queue",
      handler: async () => "my payload response"
    });

    const silentQ = taskQueue({
      name: "ignore-this-queue",
      handler: async () => "shhh"
    });

    await OqronKit.init({ config: { project: "test", environment: "test", modules: ["taskQueue"] } });

    // Enqueue jobs on both
    await silentQ.add({});
    await activeQ.add({});
    await activeQ.add({});
    
    await vi.advanceTimersByTimeAsync(150);

    // Watcher should explicitly ONLY count events strictly matching "telemetry-queue"
    expect(completedFired).toBe(2);

    // Securely flush bindings
    watcher.close();
  });
});
