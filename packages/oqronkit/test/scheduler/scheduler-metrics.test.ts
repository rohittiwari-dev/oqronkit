import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SchedulerMetrics } from "../../src/scheduler/scheduler-metrics.js";
import { OqronEventBus } from "../../src/engine/events/event-bus.js";

describe("SchedulerMetrics (G6)", () => {
	let metrics: SchedulerMetrics;

	beforeEach(() => {
		metrics = new SchedulerMetrics();
		metrics.start();
	});

	afterEach(() => {
		metrics.stop();
		OqronEventBus.removeAllListeners();
	});

	// ── Counter tracking ────────────────────────────────────────────────────

	describe("Counter tracking", () => {
		it("tracks runs on schedule:fire:start", () => {
			OqronEventBus.emit("schedule:fire:start", "billing-sync", "run-1", "cron");
			OqronEventBus.emit("schedule:fire:start", "billing-sync", "run-2", "cron");

			const m = metrics.getMetricsForSchedule("billing-sync");
			expect(m).toBeDefined();
			expect(m!.runs).toBe(2);
			expect(m!.type).toBe("cron");
		});

		it("tracks successes on schedule:fire:complete with completed status", () => {
			OqronEventBus.emit("schedule:fire:start", "report-gen", "run-1", "schedule");
			OqronEventBus.emit("schedule:fire:complete", "report-gen", "run-1", "completed", 150);

			const m = metrics.getMetricsForSchedule("report-gen");
			expect(m!.successes).toBe(1);
			expect(m!.failures).toBe(0);
		});

		it("tracks failures on schedule:fire:complete with failed status", () => {
			OqronEventBus.emit("schedule:fire:start", "flaky-job", "run-1", "cron");
			OqronEventBus.emit("schedule:fire:complete", "flaky-job", "run-1", "failed", 50);

			const m = metrics.getMetricsForSchedule("flaky-job");
			expect(m!.successes).toBe(0);
			expect(m!.failures).toBe(1);
		});

		it("tracks rate-limited events", () => {
			OqronEventBus.emit("schedule:fire:start", "rate-test", "run-1", "cron");
			OqronEventBus.emit("schedule:rate-limited", "rate-test");
			OqronEventBus.emit("schedule:rate-limited", "rate-test");

			const m = metrics.getMetricsForSchedule("rate-test");
			expect(m!.rateLimited).toBe(2);
		});

		it("tracks mixed success/failure across multiple runs", () => {
			const name = "mixed-job";
			OqronEventBus.emit("schedule:fire:start", name, "r1", "cron");
			OqronEventBus.emit("schedule:fire:complete", name, "r1", "completed", 100);

			OqronEventBus.emit("schedule:fire:start", name, "r2", "cron");
			OqronEventBus.emit("schedule:fire:complete", name, "r2", "failed", 50);

			OqronEventBus.emit("schedule:fire:start", name, "r3", "cron");
			OqronEventBus.emit("schedule:fire:complete", name, "r3", "completed", 200);

			const m = metrics.getMetricsForSchedule(name);
			expect(m!.runs).toBe(3);
			expect(m!.successes).toBe(2);
			expect(m!.failures).toBe(1);
		});
	});

	// ── Duration histograms ──────────────────────────────────────────────────

	describe("Duration histograms", () => {
		it("computes min/max/avg/last for durations", () => {
			const name = "duration-test";
			OqronEventBus.emit("schedule:fire:start", name, "r1", "cron");
			OqronEventBus.emit("schedule:fire:complete", name, "r1", "completed", 100);

			OqronEventBus.emit("schedule:fire:start", name, "r2", "cron");
			OqronEventBus.emit("schedule:fire:complete", name, "r2", "completed", 300);

			OqronEventBus.emit("schedule:fire:start", name, "r3", "cron");
			OqronEventBus.emit("schedule:fire:complete", name, "r3", "completed", 200);

			const m = metrics.getMetricsForSchedule(name)!;
			expect(m.duration.min).toBe(100);
			expect(m.duration.max).toBe(300);
			expect(m.duration.avg).toBe(200);
			expect(m.duration.last).toBe(200);
		});

		it("computes p95/p99 correctly with enough data points", () => {
			const name = "percentile-test";

			// Generate 100 data points: 1ms, 2ms, ..., 100ms
			for (let i = 1; i <= 100; i++) {
				OqronEventBus.emit("schedule:fire:start", name, `r${i}`, "cron");
				OqronEventBus.emit("schedule:fire:complete", name, `r${i}`, "completed", i);
			}

			const m = metrics.getMetricsForSchedule(name)!;
			expect(m.duration.min).toBe(1);
			expect(m.duration.max).toBe(100);
			expect(m.duration.p95).toBe(96); // 95th percentile of 1..100
			expect(m.duration.p99).toBe(100); // 99th percentile of 1..100
		});

		it("returns zeroed stats when no durations are recorded", () => {
			const name = "empty-duration";
			OqronEventBus.emit("schedule:fire:start", name, "r1", "cron");
			// No completion event

			const m = metrics.getMetricsForSchedule(name)!;
			expect(m.duration.min).toBe(0);
			expect(m.duration.max).toBe(0);
			expect(m.duration.avg).toBe(0);
		});
	});

	// ── Snapshot API ─────────────────────────────────────────────────────────

	describe("getMetrics() snapshot", () => {
		it("returns a full snapshot with aggregate totals", () => {
			// Schedule A: 2 runs, 2 successes
			OqronEventBus.emit("schedule:fire:start", "sched-a", "r1", "cron");
			OqronEventBus.emit("schedule:fire:complete", "sched-a", "r1", "completed", 100);
			OqronEventBus.emit("schedule:fire:start", "sched-a", "r2", "cron");
			OqronEventBus.emit("schedule:fire:complete", "sched-a", "r2", "completed", 150);

			// Schedule B: 1 run, 1 failure
			OqronEventBus.emit("schedule:fire:start", "sched-b", "r1", "schedule");
			OqronEventBus.emit("schedule:fire:complete", "sched-b", "r1", "failed", 30);

			const snapshot = metrics.getMetrics();
			expect(snapshot.totalSchedules).toBe(2);
			expect(snapshot.totalRuns).toBe(3);
			expect(snapshot.totalSuccesses).toBe(2);
			expect(snapshot.totalFailures).toBe(1);
			expect(snapshot.schedules).toHaveLength(2);
			expect(snapshot.timestamp).toBeInstanceOf(Date);
		});

		it("returns empty snapshot when no events have fired", () => {
			const snapshot = metrics.getMetrics();
			expect(snapshot.totalSchedules).toBe(0);
			expect(snapshot.totalRuns).toBe(0);
			expect(snapshot.schedules).toHaveLength(0);
		});
	});

	// ── Per-schedule lookup ──────────────────────────────────────────────────

	describe("getMetricsForSchedule()", () => {
		it("returns undefined for unknown schedules", () => {
			expect(metrics.getMetricsForSchedule("nonexistent")).toBeUndefined();
		});

		it("returns complete metric shape", () => {
			OqronEventBus.emit("schedule:fire:start", "shape-test", "r1", "cron");
			OqronEventBus.emit("schedule:fire:complete", "shape-test", "r1", "completed", 42);

			const m = metrics.getMetricsForSchedule("shape-test")!;
			expect(m).toMatchObject({
				name: "shape-test",
				type: "cron",
				runs: 1,
				successes: 1,
				failures: 0,
				stalls: 0,
				rateLimited: 0,
			});
			expect(m.duration).toBeDefined();
			expect(m.lastRunAt).toBeInstanceOf(Date);
		});
	});

	// ── Reset ────────────────────────────────────────────────────────────────

	describe("resetMetrics()", () => {
		it("clears all accumulated data", () => {
			OqronEventBus.emit("schedule:fire:start", "reset-test", "r1", "cron");
			OqronEventBus.emit("schedule:fire:complete", "reset-test", "r1", "completed", 100);

			expect(metrics.getMetrics().totalSchedules).toBe(1);

			metrics.resetMetrics();

			expect(metrics.getMetrics().totalSchedules).toBe(0);
			expect(metrics.getMetricsForSchedule("reset-test")).toBeUndefined();
		});
	});

	// ── Lifecycle ────────────────────────────────────────────────────────────

	describe("start/stop lifecycle", () => {
		it("stop() prevents further event processing", () => {
			metrics.stop();

			OqronEventBus.emit("schedule:fire:start", "after-stop", "r1", "cron");
			expect(metrics.getMetricsForSchedule("after-stop")).toBeUndefined();
		});

		it("start() is idempotent — calling twice doesn't double-count", () => {
			metrics.start(); // Already started in beforeEach

			OqronEventBus.emit("schedule:fire:start", "idempotent", "r1", "cron");

			const m = metrics.getMetricsForSchedule("idempotent");
			expect(m!.runs).toBe(1); // Not 2
		});
	});
});
