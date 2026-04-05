import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { OqronKit, queue } from "../../src/index.js";
import { OqronEventBus, OqronRegistry } from "../../src/engine/index.js";

describe("Queue — disabledBehavior enforcement", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await OqronKit.stop();
    OqronRegistry.getInstance()._reset();
  });

  // ── HOLD (default) ────────────────────────────────────────────────────────

  it("hold: saves a paused job with pausedReason='disabled-hold' when instance is disabled", async () => {
    const q = queue<{ msg: string }>({
      name: "hold-queue",
      handler: async () => {},
    });

    await OqronKit.init({
      config: {
        environment: "test",
        project: "test-proj",
        modules: ["queue"],
      },
    });

    // Disable the instance
    const container = (await import("../../src/engine/index.js")).OqronContainer.get();
    await container.storage.save("queue_instances", "hold-queue", { enabled: false });

    const job = await q.add({ msg: "hello" });

    expect(job.status).toBe("paused");
    expect((job as any).pausedReason).toBe("disabled-hold");
  });

  it("hold: does NOT publish to broker when instance is disabled", async () => {
    const q = queue<{ msg: string }>({
      name: "hold-queue-2",
      handler: async () => {},
    });

    await OqronKit.init({
      config: {
        environment: "test",
        project: "test-proj",
        modules: ["queue"],
      },
    });

    const container = (await import("../../src/engine/index.js")).OqronContainer.get();
    const publishSpy = vi.spyOn(container.broker, "publish");
    await container.storage.save("queue_instances", "hold-queue-2", { enabled: false });

    await q.add({ msg: "hello" });

    expect(publishSpy).not.toHaveBeenCalled();
  });

  // ── SKIP ──────────────────────────────────────────────────────────────────

  it("skip: silently drops the job without enqueueing", async () => {
    const q = queue<{ msg: string }>({
      name: "skip-queue",
      disabledBehavior: "skip",
      handler: async () => {},
    });

    await OqronKit.init({
      config: {
        environment: "test",
        project: "test-proj",
        modules: ["queue"],
      },
    });

    const container = (await import("../../src/engine/index.js")).OqronContainer.get();
    await container.storage.save("queue_instances", "skip-queue", { enabled: false });

    const job = await q.add({ msg: "should be dropped" });

    // Returns a mock response — nothing stored
    expect(job.status).toBe("completed");

    // Verify nothing was persisted
    const stored = await container.storage.get<any>("jobs", job.id);
    expect(stored).toBeNull();
  });

  // ── REJECT ────────────────────────────────────────────────────────────────

  it("reject: throws an error when instance is disabled", async () => {
    const q = queue<{ msg: string }>({
      name: "reject-queue",
      disabledBehavior: "reject",
      handler: async () => {},
    });

    await OqronKit.init({
      config: {
        environment: "test",
        project: "test-proj",
        modules: ["queue"],
      },
    });

    const container = (await import("../../src/engine/index.js")).OqronContainer.get();
    await container.storage.save("queue_instances", "reject-queue", { enabled: false });

    await expect(q.add({ msg: "rejected" })).rejects.toThrow(
      /disabled and configured to reject/,
    );
  });

  // ── Module-level fallback ─────────────────────────────────────────────────

  it("uses module-level disabledBehavior when per-queue config is not set", async () => {
    const q = queue<{ msg: string }>({
      name: "module-fallback-queue",
      // No per-queue disabledBehavior
      handler: async () => {},
    });

    await OqronKit.init({
      config: {
        environment: "test",
        project: "test-proj",
        modules: [{ module: "queue", disabledBehavior: "reject" }],
      },
    });

    const container = (await import("../../src/engine/index.js")).OqronContainer.get();
    await container.storage.save("queue_instances", "module-fallback-queue", { enabled: false });

    await expect(q.add({ msg: "test" })).rejects.toThrow(
      /disabled and configured to reject/,
    );
  });

  // ── Normal operation (enabled) ────────────────────────────────────────────

  it("processes normally when instance is enabled, regardless of disabledBehavior", async () => {
    let processed = false;

    const q = queue<{ msg: string }>({
      name: "enabled-queue",
      disabledBehavior: "reject", // This should not matter when enabled
      handler: async (job) => {
        processed = true;
        expect(job.data.msg).toBe("hello");
      },
    });

    await OqronKit.init({
      config: {
        environment: "test",
        project: "test-proj",
        modules: ["queue"],
      },
    });

    const job = await q.add({ msg: "hello" });
    expect(job.status).toBe("waiting");

    await vi.advanceTimersByTimeAsync(100);
    expect(processed).toBe(true);
  });
});
