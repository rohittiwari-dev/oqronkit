import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CronEngine } from "../../src/scheduler/cron-engine.js";
import { ScheduleEngine } from "../../src/scheduler/schedule-engine.js";
import { MemoryStore } from "../../src/engine/memory/memory-store.js";
import { MemoryLock } from "../../src/engine/memory/memory-lock.js";
import { createLogger, OqronEventBus } from "../../src/engine/index.js";

const logger = createLogger({ level: "error" }, { module: "dynamic-crud-test" });

describe("Dynamic CRUD API (G1)", () => {
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

	// ── CronEngine CRUD ────────────────────────────────────────────────────

	describe("CronEngine", () => {
		function makeCronEngine(schedules: any[] = []) {
			return new CronEngine(schedules, logger, "test", "default", {}, container);
		}

		it("upsert() creates a new cron schedule at runtime", async () => {
			const engine = makeCronEngine();
			await engine.init();

			await engine.upsert({
				name: "dynamic-cron",
				expression: "*/10 * * * *",
				handler: async () => "ok",
			});

			const record = await storage.get<any>("cron_schedules", "dynamic-cron");
			expect(record).toBeDefined();
			expect(record.name).toBe("dynamic-cron");
			expect(record.expression).toBe("*/10 * * * *");
			expect(record.nextRunAt).toBeDefined();
			expect(record.type).toBe("cron");
		});

		it("upsert() emits schedule:created for new schedules", async () => {
			const engine = makeCronEngine();
			await engine.init();

			const events: any[] = [];
			OqronEventBus.on("schedule:created", (name, type) => {
				events.push({ name, type });
			});

			await engine.upsert({
				name: "event-test",
				expression: "0 * * * *",
				handler: async () => {},
			});

			expect(events).toHaveLength(1);
			expect(events[0]).toEqual({ name: "event-test", type: "cron" });
		});

		it("upsert() emits schedule:updated for existing schedules", async () => {
			const engine = makeCronEngine([{
				name: "existing-cron",
				expression: "*/5 * * * *",
				handler: async () => {},
			}]);
			await engine.init();

			const events: any[] = [];
			OqronEventBus.on("schedule:updated", (name, type) => {
				events.push({ name, type });
			});

			await engine.upsert({
				name: "existing-cron",
				expression: "*/15 * * * *",
				handler: async () => {},
			});

			expect(events).toHaveLength(1);
			expect(events[0]).toEqual({ name: "existing-cron", type: "cron" });

			// Verify expression updated in storage
			const record = await storage.get<any>("cron_schedules", "existing-cron");
			expect(record.expression).toBe("*/15 * * * *");
		});

		it("upsert() validates cron expressions and throws on invalid", async () => {
			const engine = makeCronEngine();
			await engine.init();

			await expect(
				engine.upsert({
					name: "bad-cron",
					expression: "*/99 99 99 99 99",
					handler: async () => {},
				}),
			).rejects.toThrow();
		});

		it("upsert() preserves operational state (runCount, etc.) on update", async () => {
			const engine = makeCronEngine([{
				name: "counter-cron",
				expression: "*/5 * * * *",
				handler: async () => {},
			}]);
			await engine.init();

			// Simulate some runs
			await storage.save("cron_schedules", "counter-cron", {
				...(await storage.get<any>("cron_schedules", "counter-cron")),
				runCount: 42,
				successCount: 40,
				failCount: 2,
			});

			await engine.upsert({
				name: "counter-cron",
				expression: "*/10 * * * *",
				handler: async () => {},
			});

			const record = await storage.get<any>("cron_schedules", "counter-cron");
			expect(record.runCount).toBe(42);
			expect(record.successCount).toBe(40);
			expect(record.failCount).toBe(2);
		});

		it("remove() deletes a schedule and emits schedule:deleted", async () => {
			const engine = makeCronEngine([{
				name: "delete-me",
				expression: "*/5 * * * *",
				handler: async () => {},
			}]);
			await engine.init();

			const events: any[] = [];
			OqronEventBus.on("schedule:deleted", (name, type) => {
				events.push({ name, type });
			});

			await engine.remove("delete-me");

			const record = await storage.get<any>("cron_schedules", "delete-me");
			expect(record).toBeNull();
			expect(events).toHaveLength(1);
			expect(events[0]).toEqual({ name: "delete-me", type: "cron" });
		});

		it("remove() is a no-op for non-existent schedules", async () => {
			const engine = makeCronEngine();
			await engine.init();

			// Should not throw
			await engine.remove("ghost");
		});

		it("get() returns stored schedule state", async () => {
			const engine = makeCronEngine([{
				name: "get-me",
				expression: "0 9 * * *",
				handler: async () => {},
			}]);
			await engine.init();

			const record = await engine.get("get-me");
			expect(record).toBeDefined();
			expect(record.name).toBe("get-me");
			expect(record.nextRunAt).toBeDefined();
		});

		it("get() returns null for unknown schedules", async () => {
			const engine = makeCronEngine();
			await engine.init();

			const record = await engine.get("unknown");
			expect(record).toBeNull();
		});

		it("list() returns all schedule records", async () => {
			const engine = makeCronEngine([
				{ name: "cron-a", expression: "0 * * * *", handler: async () => {} },
				{ name: "cron-b", expression: "30 * * * *", handler: async () => {} },
			]);
			await engine.init();

			const records = await engine.list();
			expect(records).toHaveLength(2);
			const names = records.map((r: any) => r.name).sort();
			expect(names).toEqual(["cron-a", "cron-b"]);
		});

		it("full lifecycle: upsert → get → list → remove → list", async () => {
			const engine = makeCronEngine();
			await engine.init();

			// Create
			await engine.upsert({
				name: "lifecycle-test",
				expression: "*/5 * * * *",
				handler: async () => {},
			});

			// Get
			const record = await engine.get("lifecycle-test");
			expect(record).toBeDefined();
			expect(record.name).toBe("lifecycle-test");

			// List
			const list1 = await engine.list();
			expect(list1).toHaveLength(1);

			// Remove
			await engine.remove("lifecycle-test");

			// Verify gone
			const afterDelete = await engine.get("lifecycle-test");
			expect(afterDelete).toBeNull();
			const list2 = await engine.list();
			expect(list2).toHaveLength(0);
		});
	});

	// ── ScheduleEngine CRUD ────────────────────────────────────────────────

	describe("ScheduleEngine", () => {
		function makeScheduleEngine(schedules: any[] = []) {
			return new ScheduleEngine(schedules, logger, "test", "default", {}, container);
		}

		it("upsert() creates a new schedule at runtime", async () => {
			const engine = makeScheduleEngine();
			await engine.init();

			await engine.upsert({
				name: "dynamic-schedule",
				every: { minutes: 30 },
				handler: async () => "done",
			});

			const record = await storage.get<any>("schedule_schedules", "dynamic-schedule");
			expect(record).toBeDefined();
			expect(record.name).toBe("dynamic-schedule");
			expect(record.nextRunAt).toBeDefined();
			expect(record.type).toBe("schedule");
		});

		it("upsert() emits schedule:created for new schedules", async () => {
			const engine = makeScheduleEngine();
			await engine.init();

			const events: any[] = [];
			OqronEventBus.on("schedule:created", (name, type) => {
				events.push({ name, type });
			});

			await engine.upsert({
				name: "sched-event",
				every: { hours: 1 },
				handler: async () => {},
			});

			expect(events).toHaveLength(1);
			expect(events[0]).toEqual({ name: "sched-event", type: "schedule" });
		});

		it("remove() cleans up schedule from storage", async () => {
			const engine = makeScheduleEngine([{
				name: "sched-remove",
				every: { minutes: 10 },
				handler: async () => {},
			}]);
			await engine.init();

			await engine.remove("sched-remove");

			const record = await storage.get<any>("schedule_schedules", "sched-remove");
			expect(record).toBeNull();
		});

		it("registerDynamic() delegates to upsert() (backward compat)", async () => {
			const engine = makeScheduleEngine();
			await engine.init();

			const events: any[] = [];
			OqronEventBus.on("schedule:created", (name, type) => {
				events.push({ name, type });
			});

			await engine.registerDynamic({
				name: "compat-test",
				every: { minutes: 5 },
				handler: async () => {},
			});

			// Should have used upsert path and emitted event
			expect(events).toHaveLength(1);
			const record = await storage.get<any>("schedule_schedules", "compat-test");
			expect(record).toBeDefined();
		});

		it("cancel() delegates to remove() (backward compat)", async () => {
			const engine = makeScheduleEngine([{
				name: "compat-cancel",
				every: { minutes: 5 },
				handler: async () => {},
			}]);
			await engine.init();

			const events: any[] = [];
			OqronEventBus.on("schedule:deleted", (name) => {
				events.push(name);
			});

			await engine.cancel("compat-cancel");

			expect(events).toHaveLength(1);
			const record = await storage.get<any>("schedule_schedules", "compat-cancel");
			expect(record).toBeNull();
		});

		it("list() returns all schedule records", async () => {
			const engine = makeScheduleEngine([
				{ name: "s-a", every: { minutes: 1 }, handler: async () => {} },
				{ name: "s-b", every: { hours: 1 }, handler: async () => {} },
				{ name: "s-c", every: { days: 1 }, handler: async () => {} },
			]);
			await engine.init();

			const records = await engine.list();
			expect(records).toHaveLength(3);
		});
	});
});
