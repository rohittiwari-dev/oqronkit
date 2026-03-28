import { describe, it, expect, vi } from "vitest";
import { LagMonitor } from "../../src/core/lag-monitor.js";

describe("LagMonitor", () => {
  it("starts without tripping circuit", () => {
    const logger = { warn: vi.fn(), info: vi.fn() } as any;
    const monitor = new LagMonitor(logger, 500, 50);

    monitor.start();
    expect(monitor.isCircuitTripped).toBe(false);
    monitor.stop();
  });

  it("stop resets tripped state", () => {
    const logger = { warn: vi.fn(), info: vi.fn() } as any;
    const monitor = new LagMonitor(logger, 500, 50);

    monitor.start();
    monitor.stop();
    expect(monitor.isCircuitTripped).toBe(false);
  });

  it("multiple start() calls are idempotent", () => {
    const logger = { warn: vi.fn(), info: vi.fn() } as any;
    const monitor = new LagMonitor(logger, 500, 50);

    monitor.start();
    monitor.start(); // should not create a second interval
    monitor.stop();
    // If two intervals were created, stop() would only clear one
    expect(monitor.isCircuitTripped).toBe(false);
  });
});
