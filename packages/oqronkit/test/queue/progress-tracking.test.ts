import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OqronContainer } from "../../src/engine/container.js";
import { OqronEventBus } from "../../src/engine/events/event-bus.js";
import { createLogger } from "../../src/engine/logger/index.js";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";
import { MemoryLock } from "../../src/engine/memory/memory-lock.js";
import { MemoryStore } from "../../src/engine/memory/memory-store.js";
import { queue } from "../../src/queue/define-queue.js";
import { QueueEngine } from "../../src/queue/queue-engine.js";

describe("QueueEngine — Progress Tracking", () => {
  const logger = createLogger({ enabled: false }, { module: "test" });

  beforeEach(() => {
    OqronContainer.init(new MemoryStore(), new MemoryBroker(), new MemoryLock(), {
      project: "test",
      environment: "test",
    });
  });

  afterEach(() => {
    OqronContainer.reset();
    OqronEventBus.removeAllListeners();
  });

  it("progress values are persisted to the job record", async () => {
    const q = queue<{ x: number }>({
      name: "q-progress",
      handler: async (ctx) => {
        await ctx.progress(25, "Starting");
        await ctx.progress(50, "Midway");
        await ctx.progress(100, "Done");
      },
    });

    const job = await q.add({ x: 1 });

    const engine = new QueueEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "queue", heartbeatMs: 50 },
    );
    await engine.init();
    await engine.start();
    await new Promise((r) => setTimeout(r, 500));
    await engine.stop();

    const di = OqronContainer.get();
    const finalJob = await di.storage.get<any>("jobs", job.id);
    // Final progress should be 100% (set by handler, then overridden to 100 on completion)
    expect(finalJob.progressPercent).toBe(100);
  });

  it("timeline entries are capped at maxTimelineEntries (JE1 validation)", async () => {
    const q = queue<{ x: number }>({
      name: "q-timeline-cap",
      handler: async (ctx) => {
        // Generate many progress updates to exceed the cap
        for (let i = 0; i < 200; i++) {
          await ctx.progress(i, `Step ${i}`);
        }
      },
    });

    const job = await q.add({ x: 1 });

    const engine = new QueueEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "queue", heartbeatMs: 50 },
    );
    await engine.init();
    await engine.start();
    await new Promise((r) => setTimeout(r, 2000));
    await engine.stop();

    const di = OqronContainer.get();
    const finalJob = await di.storage.get<any>("jobs", job.id);

    // Timeline should be capped (100 is the current MAX_TIMELINE_ENTRIES)
    if (finalJob.timeline) {
      expect(finalJob.timeline.length).toBeLessThanOrEqual(100);
    }
  });

  it("job:progress event is emitted on progress update", async () => {
    const progressEvents: Array<{ queueName: string; jobId: string; percent: number }> = [];
    OqronEventBus.on("job:progress", (queueName, jobId, percent) => {
      progressEvents.push({ queueName, jobId, percent });
    });

    const q = queue<{ x: number }>({
      name: "q-progress-event",
      handler: async (ctx) => {
        await ctx.progress(50, "Half done");
      },
    });

    const job = await q.add({ x: 1 });

    const engine = new QueueEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "queue", heartbeatMs: 50 },
    );
    await engine.init();
    await engine.start();
    await new Promise((r) => setTimeout(r, 500));
    await engine.stop();

    expect(progressEvents.length).toBeGreaterThanOrEqual(1);
    const progressEvent = progressEvents.find((e) => e.jobId === job.id);
    expect(progressEvent).toBeDefined();
    expect(progressEvent!.percent).toBe(50);
  });
});
