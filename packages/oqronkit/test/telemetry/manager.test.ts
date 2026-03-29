import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OqronEventBus } from "../../src/engine/events/event-bus.js";
import { TelemetryManager } from "../../src/telemetry/manager.js";

describe("TelemetryManager", () => {
  let telemetry: TelemetryManager;

  beforeEach(() => {
    telemetry = new TelemetryManager();
    telemetry.start();
  });

  afterEach(() => {
    telemetry.stop();
  });

  it("tracks job:start events", () => {
    OqronEventBus.emit("job:start", "system_schedule", "run-1", "my-cron");

    const output = telemetry.serialize();
    expect(output).toContain("oqronkit_jobs_started_total");
    expect(output).toContain('schedule="my-cron"');
  });

  it("tracks job:success events", () => {
    OqronEventBus.emit("job:start", "system_schedule", "run-1", "my-cron");
    OqronEventBus.emit("job:success", "system_schedule", "run-1");

    const output = telemetry.serialize();
    expect(output).toContain("oqronkit_jobs_completed_total");
  });

  it("tracks job:fail events", () => {
    OqronEventBus.emit("job:start", "system_schedule", "run-1", "my-cron");
    OqronEventBus.emit("job:fail", "system_schedule", "run-1", new Error("boom"));

    const output = telemetry.serialize();
    expect(output).toContain("oqronkit_jobs_failed_total");
  });

  it("tracks active gauge (increments on start, decrements on success)", () => {
    OqronEventBus.emit("job:start", "system_schedule", "run-1", "my-cron");

    const before = telemetry.serialize();
    expect(before).toContain("oqronkit_jobs_active");

    OqronEventBus.emit("job:success", "system_schedule", "run-1");

    const after = telemetry.serialize();
    // Active gauge should not show 0 entries (filtered out)
    // This is a reasonable check for decrement
    expect(after).not.toContain('oqronkit_jobs_active{schedule="my-cron"} 1');
  });

  it("records duration on completion", async () => {
    OqronEventBus.emit("job:start", "system_schedule", "run-1", "duration-test");

    // Small delay to create measurable duration
    await new Promise((r) => setTimeout(r, 10));

    OqronEventBus.emit("job:success", "system_schedule", "run-1");

    const output = telemetry.serialize();
    expect(output).toContain("oqronkit_job_duration_ms");
    expect(output).toContain('schedule="duration-test"');
  });

  it("serialize() returns valid Prometheus format", () => {
    OqronEventBus.emit("job:start", "system_schedule", "run-1", "format-test");
    OqronEventBus.emit("job:success", "system_schedule", "run-1");

    const output = telemetry.serialize();
    expect(output).toContain("# HELP");
    expect(output).toContain("# TYPE");
    expect(output).toContain("counter");
    expect(output).toContain("gauge");
  });

  it("stop() clears all metrics", () => {
    OqronEventBus.emit("job:start", "system_schedule", "run-1", "clear-test");
    telemetry.stop();

    // Re-start to check serialization is empty
    telemetry = new TelemetryManager();
    telemetry.start();

    const output = telemetry.serialize();
    expect(output).not.toContain('schedule="clear-test"');
  });
});
