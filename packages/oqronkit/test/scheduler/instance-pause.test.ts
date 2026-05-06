import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CronEngine } from "../../src/scheduler/cron-engine.js";
import { ScheduleEngine } from "../../src/scheduler/schedule-engine.js";
import { MemoryStore } from "../../src/engine/memory/memory-store.js";
import { MemoryLock } from "../../src/engine/memory/memory-lock.js";
import { createLogger, OqronEventBus } from "../../src/engine/index.js";

const logger = createLogger({ level: "error" }, { module: "instance-pause-test" });

describe("Per-Instance Pause/Resume API", () => {
	let storage: MemoryStore;
	let lock: MemoryLock;
	let container: any;

	beforeEach(() => {
		storage = new MemoryStore();
		lock = new MemoryLock();
		container = { storage, lock };
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		OqronEventBus.removeAllListeners();
	});

	// ── CronEngine ────────────────────────────────────────────────────────

	describe("CronEngine", () => {
		function makeCronEngine(schedules: any[] = []) {
			return new CronEngine(schedules, logger, "test", "default", {}, container);
		}

		it("pauseInstance() sets paused flag in storage", async () => {
			const engine = makeCronEngine([{
				name: "pause-cron",
				expression: "*/5 * * * *",
				handler: async () => {},
			}]);
			await engine.init();

			await engine.pauseInstance("pause-cron");

			const record = await storage.get<any>("cron_schedules", "pause-cron");
			expect(record.paused).toBe(true);
			expect(record.pausedAt).toBeDefined();
		});

		it("pauseInstance() emits schedule:paused event", async () => {
			const engine = makeCronEngine([{
				name: "event-cron",
				expression: "*/5 * * * *",
				handler: async () => {},
			}]);
			await engine.init();

			const events: string[] = [];
			OqronEventBus.on("schedule:paused", (name) => events.push(name));

			await engine.pauseInstance("event-cron");

			expect(events).toEqual(["event-cron"]);
		});

		it("pauseInstance() is idempotent — no double-emit", async () => {
			const engine = makeCronEngine([{
				name: "idem-cron",
				expression: "*/5 * * * *",
				handler: async () => {},
			}]);
			await engine.init();

			const events: string[] = [];
			OqronEventBus.on("schedule:paused", (name) => events.push(name));

			await engine.pauseInstance("idem-cron");
			await engine.pauseInstance("idem-cron");

			// Should only emit once
			expect(events).toEqual(["idem-cron"]);
		});

		it("resumeInstance() clears paused flag in storage", async () => {
			const engine = makeCronEngine([{
				name: "resume-cron",
				expression: "*/5 * * * *",
				handler: async () => {},
			}]);
			await engine.init();

			await engine.pauseInstance("resume-cron");
			await engine.resumeInstance("resume-cron");

			const record = await storage.get<any>("cron_schedules", "resume-cron");
			expect(record.paused).toBe(false);
			expect(record.resumedAt).toBeDefined();
			expect(record.pausedAt).toBeUndefined();
		});

		it("resumeInstance() emits schedule:resumed event", async () => {
			const engine = makeCronEngine([{
				name: "resume-event-cron",
				expression: "*/5 * * * *",
				handler: async () => {},
			}]);
			await engine.init();

			const events: string[] = [];
			OqronEventBus.on("schedule:resumed", (name) => events.push(name));

			await engine.pauseInstance("resume-event-cron");
			await engine.resumeInstance("resume-event-cron");

			expect(events).toEqual(["resume-event-cron"]);
		});

		it("isPaused() returns true for paused instances", async () => {
			const engine = makeCronEngine([{
				name: "check-cron",
				expression: "*/5 * * * *",
				handler: async () => {},
			}]);
			await engine.init();

			expect(await engine.isPaused("check-cron")).toBe(false);

			await engine.pauseInstance("check-cron");
			expect(await engine.isPaused("check-cron")).toBe(true);

			await engine.resumeInstance("check-cron");
			expect(await engine.isPaused("check-cron")).toBe(false);
		});

		it("isPaused() returns false for non-existent instances", async () => {
			const engine = makeCronEngine();
			await engine.init();

			expect(await engine.isPaused("ghost")).toBe(false);
		});

		it("pauseInstance() is a no-op for non-existent instances", async () => {
			const engine = makeCronEngine();
			await engine.init();

			const events: string[] = [];
			OqronEventBus.on("schedule:paused", (name) => events.push(name));

			// Should not throw or emit
			await engine.pauseInstance("ghost");
			expect(events).toHaveLength(0);
		});

		it("full lifecycle: active → pause → isPaused → resume → isPaused", async () => {
			const engine = makeCronEngine([{
				name: "lifecycle-cron",
				expression: "*/5 * * * *",
				handler: async () => {},
			}]);
			await engine.init();

			// Initially active
			expect(await engine.isPaused("lifecycle-cron")).toBe(false);

			// Pause
			await engine.pauseInstance("lifecycle-cron");
			expect(await engine.isPaused("lifecycle-cron")).toBe(true);
			const pausedRecord = await engine.get("lifecycle-cron");
			expect(pausedRecord.paused).toBe(true);

			// Resume
			await engine.resumeInstance("lifecycle-cron");
			expect(await engine.isPaused("lifecycle-cron")).toBe(false);
			const resumedRecord = await engine.get("lifecycle-cron");
			expect(resumedRecord.paused).toBe(false);
		});
	});

	// ── ScheduleEngine ────────────────────────────────────────────────────

	describe("ScheduleEngine", () => {
		function makeScheduleEngine(schedules: any[] = []) {
			return new ScheduleEngine(schedules, logger, "test", "default", {}, container);
		}

		it("pauseInstance() pauses a schedule and emits event", async () => {
			const engine = makeScheduleEngine([{
				name: "pause-sched",
				every: { minutes: 10 },
				handler: async () => {},
			}]);
			await engine.init();

			const events: string[] = [];
			OqronEventBus.on("schedule:paused", (name) => events.push(name));

			await engine.pauseInstance("pause-sched");

			const record = await storage.get<any>("schedule_schedules", "pause-sched");
			expect(record.paused).toBe(true);
			expect(events).toEqual(["pause-sched"]);
		});

		it("resumeInstance() resumes a paused schedule and emits event", async () => {
			const engine = makeScheduleEngine([{
				name: "resume-sched",
				every: { minutes: 10 },
				handler: async () => {},
			}]);
			await engine.init();

			const events: string[] = [];
			OqronEventBus.on("schedule:resumed", (name) => events.push(name));

			await engine.pauseInstance("resume-sched");
			await engine.resumeInstance("resume-sched");

			const record = await storage.get<any>("schedule_schedules", "resume-sched");
			expect(record.paused).toBe(false);
			expect(events).toEqual(["resume-sched"]);
		});

		it("isPaused() correctly reports state for schedule instances", async () => {
			const engine = makeScheduleEngine([{
				name: "check-sched",
				every: { hours: 1 },
				handler: async () => {},
			}]);
			await engine.init();

			expect(await engine.isPaused("check-sched")).toBe(false);

			await engine.pauseInstance("check-sched");
			expect(await engine.isPaused("check-sched")).toBe(true);

			await engine.resumeInstance("check-sched");
			expect(await engine.isPaused("check-sched")).toBe(false);
		});
	});
});
