import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OqronContainer } from "../../src/engine/container.js";
import { OqronEventBus } from "../../src/engine/events/event-bus.js";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";
import { MemoryLock } from "../../src/engine/memory/memory-lock.js";
import { MemoryStore } from "../../src/engine/memory/memory-store.js";
import { WorkerMetrics } from "../../src/worker/worker-metrics.js";

describe("WorkerMetrics", () => {
  let metrics: WorkerMetrics;

  beforeEach(() => {
    OqronContainer.init(new MemoryStore(), new MemoryBroker(), new MemoryLock(), { project: "test", environment: "test" });
    metrics = new WorkerMetrics();
    metrics.start();
  });

  afterEach(() => {
    metrics.stop();
    OqronContainer.reset();
    OqronEventBus.removeAllListeners();
  });

  it("tracks counters and durations", () => {
    OqronEventBus.emit("worker:job:claimed", "t1", "j1");
    OqronEventBus.emit("worker:job:completed", "t1", "j1", 100);
    OqronEventBus.emit("worker:job:claimed", "t1", "j2");
    OqronEventBus.emit("worker:job:failed", "t1", "j2", 50);

    const snap = metrics.getMetrics();
    expect(snap.totalProcessed).toBe(2);
    expect(snap.totalCompleted).toBe(1);
    expect(snap.totalFailed).toBe(1);

    const e = metrics.getMetricsForWorker("t1");
    expect(e!.duration.min).toBe(50);
    expect(e!.duration.max).toBe(100);
  });

  it("returns undefined for unknown topic", () => {
    expect(metrics.getMetricsForWorker("ghost")).toBeUndefined();
  });

  it("resetMetrics clears all data", () => {
    OqronEventBus.emit("worker:job:claimed", "r", "j1");
    metrics.resetMetrics();
    expect(metrics.getMetrics().totalWorkers).toBe(0);
  });
});
