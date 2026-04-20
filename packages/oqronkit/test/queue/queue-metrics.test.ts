import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OqronContainer } from "../../src/engine/container.js";
import { OqronEventBus } from "../../src/engine/events/event-bus.js";
import { createLogger } from "../../src/engine/logger/index.js";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";
import { MemoryLock } from "../../src/engine/memory/memory-lock.js";
import { MemoryStore } from "../../src/engine/memory/memory-store.js";
import { QueueMetrics } from "../../src/queue/queue-metrics.js";

describe("QueueMetrics — event-driven metrics collection", () => {
  let metrics: QueueMetrics;

  beforeEach(() => {
    const store = new MemoryStore();
    const broker = new MemoryBroker();
    const lock = new MemoryLock();
    OqronContainer.init(store, broker, lock, {
      project: "test",
      environment: "test",
    });
    metrics = new QueueMetrics();
    metrics.start();
  });

  afterEach(() => {
    metrics.stop();
    OqronContainer.reset();
    OqronEventBus.removeAllListeners();
  });

  it("tracks claimed, completed, and failed counts", () => {
    OqronEventBus.emit("queue:job:claimed", "test-q", "j1");
    OqronEventBus.emit("queue:job:claimed", "test-q", "j2");
    OqronEventBus.emit("queue:job:completed", "test-q", "j1", 100);
    OqronEventBus.emit("queue:job:failed", "test-q", "j2", 200);

    const snap = metrics.getMetrics();
    expect(snap.totalProcessed).toBe(2);
    expect(snap.totalCompleted).toBe(1);
    expect(snap.totalFailed).toBe(1);
    expect(snap.totalQueues).toBe(1);
  });

  it("computes duration statistics", () => {
    OqronEventBus.emit("queue:job:claimed", "stats-q", "j1");
    OqronEventBus.emit("queue:job:completed", "stats-q", "j1", 100);
    OqronEventBus.emit("queue:job:claimed", "stats-q", "j2");
    OqronEventBus.emit("queue:job:completed", "stats-q", "j2", 300);
    OqronEventBus.emit("queue:job:claimed", "stats-q", "j3");
    OqronEventBus.emit("queue:job:completed", "stats-q", "j3", 200);

    const entry = metrics.getMetricsForQueue("stats-q");
    expect(entry).toBeDefined();
    expect(entry!.duration.min).toBe(100);
    expect(entry!.duration.max).toBe(300);
    expect(entry!.duration.avg).toBe(200);
  });

  it("getMetricsForQueue returns undefined for unknown queue", () => {
    expect(metrics.getMetricsForQueue("ghost")).toBeUndefined();
  });

  it("resetMetrics clears all data", () => {
    OqronEventBus.emit("queue:job:claimed", "reset-q", "j1");
    OqronEventBus.emit("queue:job:completed", "reset-q", "j1", 50);

    metrics.resetMetrics();
    const snap = metrics.getMetrics();
    expect(snap.totalProcessed).toBe(0);
    expect(snap.totalQueues).toBe(0);
  });

  it("tracks multiple queues independently", () => {
    OqronEventBus.emit("queue:job:claimed", "q-a", "j1");
    OqronEventBus.emit("queue:job:completed", "q-a", "j1", 100);
    OqronEventBus.emit("queue:job:claimed", "q-b", "j2");
    OqronEventBus.emit("queue:job:failed", "q-b", "j2", 50);

    const snap = metrics.getMetrics();
    expect(snap.totalQueues).toBe(2);

    const a = metrics.getMetricsForQueue("q-a");
    expect(a!.completed).toBe(1);
    expect(a!.failed).toBe(0);

    const b = metrics.getMetricsForQueue("q-b");
    expect(b!.completed).toBe(0);
    expect(b!.failed).toBe(1);
  });

  it("idempotent start/stop", () => {
    // Double start should not error
    metrics.start();
    metrics.start();
    // Double stop should not error
    metrics.stop();
    metrics.stop();
  });
});
