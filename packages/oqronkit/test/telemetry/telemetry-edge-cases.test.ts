import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { OqronEventBus } from "../../src/engine/events/event-bus.js";
import { TelemetryManager } from "../../src/telemetry/manager.js";

describe("TelemetryManager — Extended Coverage", () => {
  let telemetry: TelemetryManager;

  beforeEach(() => {
    telemetry = new TelemetryManager();
    telemetry.start();
  });

  afterEach(() => {
    telemetry.stop();
  });

  it("multiple start() calls are idempotent (no double listeners)", () => {
    telemetry.start(); // second call
    telemetry.start(); // third call

    OqronEventBus.emit("job:start", "q", "j1", "sched");
    OqronEventBus.emit("job:success", "q", "j1");

    const output = telemetry.serialize();
    // Should have 1 completed, not 3
    expect(output).toContain('oqronkit_jobs_completed_total{schedule="sched"} 1');
  });

  it("handles success without prior start (unknown schedule)", () => {
    OqronEventBus.emit("job:success", "q", "orphan-1");

    const output = telemetry.serialize();
    expect(output).toContain('schedule="_unknown"');
  });

  it("handles fail without prior start (unknown schedule)", () => {
    OqronEventBus.emit("job:fail", "q", "orphan-1", new Error("oops"));

    const output = telemetry.serialize();
    expect(output).toContain('schedule="_unknown"');
  });

  it("tracks multiple schedules independently", () => {
    OqronEventBus.emit("job:start", "q", "j1", "billing");
    OqronEventBus.emit("job:start", "q", "j2", "emails");
    OqronEventBus.emit("job:success", "q", "j1");
    OqronEventBus.emit("job:fail", "q", "j2", new Error("x"));

    const output = telemetry.serialize();
    expect(output).toContain('oqronkit_jobs_completed_total{schedule="billing"} 1');
    expect(output).toContain('oqronkit_jobs_failed_total{schedule="emails"} 1');
  });

  it("duration summary includes p50/p95/p99 quantiles", async () => {
    for (let i = 0; i < 5; i++) {
      OqronEventBus.emit("job:start", "q", `j-${i}`, "multi");
    }
    await new Promise((r) => setTimeout(r, 5));
    for (let i = 0; i < 5; i++) {
      OqronEventBus.emit("job:success", "q", `j-${i}`);
    }

    const output = telemetry.serialize();
    expect(output).toContain('quantile="0.5"');
    expect(output).toContain('quantile="0.95"');
    expect(output).toContain('quantile="0.99"');
    expect(output).toContain('oqronkit_job_duration_ms_count{schedule="multi"} 5');
  });

  it("active gauge does not go below 0", () => {
    // Complete without start
    OqronEventBus.emit("job:success", "q", "ghost");
    OqronEventBus.emit("job:success", "q", "ghost2");

    const output = telemetry.serialize();
    // Should not contain negative gauge values
    expect(output).not.toMatch(/oqronkit_jobs_active.*-\d/);
  });

  it("stop() removes only own listeners, not global ones", () => {
    let externalCalls = 0;
    const externalListener = () => { externalCalls++; };
    OqronEventBus.on("job:start", externalListener);

    telemetry.stop();

    // External listener should still fire
    OqronEventBus.emit("job:start", "q", "j1", "m");
    expect(externalCalls).toBe(1);

    OqronEventBus.off("job:start", externalListener);
  });

  it("serializes empty metrics without errors", () => {
    const output = telemetry.serialize();
    expect(output).toContain("# HELP");
    expect(output).toContain("# TYPE");
    // No actual metric lines yet, just headers
    expect(output).not.toContain("} ");
  });
});
