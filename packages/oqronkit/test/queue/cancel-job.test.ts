import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  initEngine,
  stopEngine,
  Storage,
} from "../../src/engine/core.js";
import { OqronRegistry } from "../../src/engine/registry.js";
import { OqronEventBus } from "../../src/engine/events/event-bus.js";
import { QueueEngine } from "../../src/queue/queue-engine.js";
import type { OqronConfig } from "../../src/engine/types/config.types.js";
import type { OqronJob } from "../../src/engine/types/job.types.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as any;
}

const config: OqronConfig = {
  project: "test",
  environment: "test",
  modules: ["queue"],
  queue: { concurrency: 1, heartbeatMs: 100 },
};

function makeJob(
  id: string,
  queueName: string,
  status: string = "active",
): OqronJob {
  return {
    id,
    type: "task",
    queueName,
    status: status as any,
    data: {},
    opts: {},
    attemptMade: 1,
    progressPercent: 0,
    tags: [],
    createdAt: new Date(),
    startedAt: new Date(),
    workerId: "w1",
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("QueueEngine — cancelActiveJob()", () => {
  let engine: QueueEngine;
  let logger: any;

  beforeEach(async () => {
    await initEngine({ project: "test", environment: "test" });
    OqronRegistry.getInstance()._reset();
    logger = createLogger();
    engine = new QueueEngine(config, logger);
  });

  afterEach(async () => {
    await engine.stop();
    await stopEngine();
    OqronEventBus.removeAllListeners();
  });

  it("returns false when jobId is not being actively executed", async () => {
    const result = await engine.cancelActiveJob("nonexistent-job");
    expect(result).toBe(false);
  });

  it("signal.aborted is false by default in handler context", async () => {
    const controller = new AbortController();
    expect(controller.signal.aborted).toBe(false);

    controller.abort();
    expect(controller.signal.aborted).toBe(true);
  });

  it("AbortController.abort() fires the abort event", async () => {
    const controller = new AbortController();
    let eventFired = false;

    controller.signal.addEventListener("abort", () => {
      eventFired = true;
    });

    controller.abort();
    expect(eventFired).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });
});

describe("OqronManager — cancelJob() with active jobs", () => {
  beforeEach(async () => {
    await initEngine({ project: "test", environment: "test" });
    OqronRegistry.getInstance()._reset();
  });

  afterEach(async () => {
    await stopEngine();
    OqronEventBus.removeAllListeners();
  });

  it("deletes non-active jobs directly from storage", async () => {
    const { OqronManager } = await import(
      "../../src/manager/oqron-manager.js"
    );
    const mgr = OqronManager.from({ project: "test", environment: "test" });

    const job = makeJob("j-waiting", "q", "waiting");
    await Storage.save("jobs", job.id, job);

    await mgr.cancelJob("j-waiting");
    const result = await Storage.get("jobs", "j-waiting");
    expect(result).toBeNull();
  });

  it("delegates to engine.cancelActiveJob for active jobs", async () => {
    const { OqronManager } = await import(
      "../../src/manager/oqron-manager.js"
    );
    const mgr = OqronManager.from({ project: "test", environment: "test" });

    // Register a mock module with cancelActiveJob
    const mockMod = {
      name: "mockEngine",
      enabled: true,
      init: async () => {},
      start: async () => {},
      stop: async () => {},
      cancelActiveJob: vi.fn().mockResolvedValue(true),
    };
    OqronRegistry.getInstance().register(mockMod);

    const job = makeJob("j-active", "q", "active");
    await Storage.save("jobs", job.id, job);

    await mgr.cancelJob("j-active");

    expect(mockMod.cancelActiveJob).toHaveBeenCalledWith("j-active");
  });

  it("falls back to storage delete if no engine claims the active job", async () => {
    const { OqronManager } = await import(
      "../../src/manager/oqron-manager.js"
    );
    const mgr = OqronManager.from({ project: "test", environment: "test" });

    // Register a module that doesn't recognize the job
    const mockMod = {
      name: "otherEngine",
      enabled: true,
      init: async () => {},
      start: async () => {},
      stop: async () => {},
      cancelActiveJob: vi.fn().mockResolvedValue(false),
    };
    OqronRegistry.getInstance().register(mockMod);

    const job = makeJob("j-orphan", "q", "active");
    await Storage.save("jobs", job.id, job);

    await mgr.cancelJob("j-orphan");

    expect(mockMod.cancelActiveJob).toHaveBeenCalledWith("j-orphan");
    const result = await Storage.get("jobs", "j-orphan");
    expect(result).toBeNull(); // Deleted via fallback
  });

  it("cancelJob on nonexistent job doesn't throw", async () => {
    const { OqronManager } = await import(
      "../../src/manager/oqron-manager.js"
    );
    const mgr = OqronManager.from({ project: "test", environment: "test" });

    await expect(mgr.cancelJob("ghost")).resolves.toBeUndefined();
  });
});

describe("AbortSignal — Integration Behavior", () => {
  it("handler can check signal.aborted periodically", async () => {
    const controller = new AbortController();
    const results: boolean[] = [];

    // Simulate a long-running handler
    const handler = async (signal: AbortSignal) => {
      for (let i = 0; i < 5; i++) {
        results.push(signal.aborted);
        if (signal.aborted) return "cancelled";
        await new Promise((r) => setTimeout(r, 5));
      }
      return "done";
    };

    // Abort after a short delay
    setTimeout(() => controller.abort(), 10);

    const result = await handler(controller.signal);

    // At least the first check should be false, and at least one should be true
    expect(results[0]).toBe(false);
    expect(results.some((v) => v === true)).toBe(true);
    expect(result).toBe("cancelled");
  });

  it("AbortSignal 'abort' event fires listeners", () => {
    const controller = new AbortController();
    const calls: string[] = [];

    controller.signal.addEventListener("abort", () => calls.push("listener1"));
    controller.signal.addEventListener("abort", () => calls.push("listener2"));

    controller.abort();

    expect(calls).toEqual(["listener1", "listener2"]);
  });

  it("signal.reason provides abort reason", () => {
    const controller = new AbortController();
    controller.abort("User cancelled");

    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe("User cancelled");
  });
});
