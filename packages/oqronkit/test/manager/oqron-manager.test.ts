import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initEngine, Storage, Broker } from "../../src/engine/core.js";
import { OqronRegistry } from "../../src/engine/registry.js";
import { OqronManager } from "../../src/manager/oqron-manager.js";
import type { OqronConfig } from "../../src/engine/types/config.types.js";
import type { OqronJob } from "../../src/engine/types/job.types.js";

const config: OqronConfig = {
  project: "test",
  environment: "test",
};

describe("OqronManager", () => {
  let manager: OqronManager;

  beforeEach(async () => {
    await initEngine(config);
    OqronRegistry.getInstance()._reset();

    // Register a fake module so getSystemStats sees something
    OqronRegistry.getInstance().register({
      name: "queue",
      enabled: true,
      init: async () => {},
      start: async () => {},
      stop: async () => {},
      triggerManual: async () => false,
    });

    manager = OqronManager.from(config);
  });

  // ── System Stats ──────────────────────────────────────────────────────────

  describe("getSystemStats()", () => {
    it("returns project, env, and module list", async () => {
      const stats = await manager.getSystemStats();
      expect(stats.project).toBe("test");
      expect(stats.env).toBe("test");
      expect(stats.modules).toHaveLength(1);
      expect(stats.modules[0]).toMatchObject({
        name: "queue",
        enabled: true,
        status: "active",
      });
    });

    it("returns total job count from storage", async () => {
      await Storage.save("jobs", "j1", { id: "j1", status: "waiting" });
      await Storage.save("jobs", "j2", { id: "j2", status: "completed" });

      const stats = await manager.getSystemStats();
      expect(stats.db.keys).toBe(2);
    });

    it("returns 0 keys when storage is empty", async () => {
      const stats = await manager.getSystemStats();
      expect(stats.db.keys).toBe(0);
    });
  });

  // ── Queue Info ────────────────────────────────────────────────────────────

  describe("getQueueInfo()", () => {
    beforeEach(async () => {
      // Seed some jobs in different states
      await Storage.save<OqronJob>("jobs", "w1", {
        id: "w1",
        type: "task",
        queueName: "emails",
        status: "waiting",
        data: {},
        opts: {},
        attemptMade: 0,
        progressPercent: 0,
        tags: [],
        createdAt: new Date(),
      });
      await Storage.save<OqronJob>("jobs", "w2", {
        id: "w2",
        type: "task",
        queueName: "emails",
        status: "waiting",
        data: {},
        opts: {},
        attemptMade: 0,
        progressPercent: 0,
        tags: [],
        createdAt: new Date(),
      });
      await Storage.save<OqronJob>("jobs", "a1", {
        id: "a1",
        type: "task",
        queueName: "emails",
        status: "active",
        data: {},
        opts: {},
        attemptMade: 0,
        progressPercent: 0,
        tags: [],
        createdAt: new Date(),
      });
      await Storage.save<OqronJob>("jobs", "f1", {
        id: "f1",
        type: "task",
        queueName: "emails",
        status: "failed",
        data: {},
        opts: {},
        attemptMade: 3,
        progressPercent: 0,
        error: "timeout",
        tags: [],
        createdAt: new Date(),
      });
    });

    it("returns correct metric counts per state", async () => {
      const result = await manager.getQueueInfo("emails");
      expect(result.metrics.active).toBe(1);
      expect(result.metrics.waiting).toBe(2);
      expect(result.metrics.failed).toBe(1);
      expect(result.metrics.completed).toBe(0);
    });

    it("returns paginated jobs for the requested state", async () => {
      const result = await manager.getQueueInfo("emails", {
        state: "waiting",
        limit: 1,
      });
      expect(result.jobs).toHaveLength(1);
    });

    it("returns all waiting jobs when limit is sufficient", async () => {
      const result = await manager.getQueueInfo("emails", {
        state: "waiting",
        limit: 50,
      });
      expect(result.jobs).toHaveLength(2);
    });
  });

  // ── Job Management ────────────────────────────────────────────────────────

  describe("getJob()", () => {
    it("returns a job by ID", async () => {
      await Storage.save("jobs", "lookup-1", {
        id: "lookup-1",
        status: "waiting",
        queueName: "test-q",
      });
      const job = await manager.getJob("lookup-1");
      expect(job).toBeTruthy();
      expect(job!.id).toBe("lookup-1");
    });

    it("returns null for non-existent job", async () => {
      const job = await manager.getJob("ghost");
      expect(job).toBeNull();
    });
  });

  describe("retryJob()", () => {
    it("creates a new waiting job linked to the failed original", async () => {
      const failedJob: OqronJob = {
        id: "retry-1",
        type: "task",
        queueName: "retry-q",
        status: "failed",
        data: { x: 1 },
        opts: {},
        attemptMade: 3,
        progressPercent: 0,
        error: "crash",
        stacktrace: ["Error: crash", "  at ..."],
        tags: [],
        createdAt: new Date(),
      };
      await Storage.save("jobs", "retry-1", failedJob);

      const retryId = await manager.retryJob("retry-1");
      expect(retryId).toBeDefined();
      expect(typeof retryId).toBe("string");

      // New retry job should exist with clean state
      const retryJob = await Storage.get<OqronJob>("jobs", retryId!);
      expect(retryJob).toBeTruthy();
      expect(retryJob!.status).toBe("waiting");
      expect(retryJob!.attemptMade).toBe(0);
      expect(retryJob!.error).toBeUndefined();
      expect(retryJob!.stacktrace).toBeUndefined();
      expect(retryJob!.retriedFromId).toBe("retry-1");
      expect(retryJob!.triggeredBy).toBe("retry");

      // Original should still exist with audit trail
      const original = await Storage.get<OqronJob>("jobs", "retry-1");
      expect(original!.status).toBe("failed"); // Not mutated
      expect(original!.retryReason).toContain(retryId!);
    });

    it("returns undefined for a non-failed job", async () => {
      await Storage.save("jobs", "active-1", {
        id: "active-1",
        type: "task",
        queueName: "q",
        status: "active",
        data: {},
        opts: {},
        attemptMade: 1,
        progressPercent: 50,
        tags: [],
        createdAt: new Date(),
      });

      const result = await manager.retryJob("active-1");
      expect(result).toBeUndefined();

      const job = await Storage.get<OqronJob>("jobs", "active-1");
      expect(job!.status).toBe("active"); // No change
    });

    it("returns undefined for a non-existent job", async () => {
      await expect(manager.retryJob("ghost")).resolves.toBeUndefined();
    });
  });

  describe("cancelJob()", () => {
    it("removes a job from storage", async () => {
      await Storage.save("jobs", "cancel-1", {
        id: "cancel-1",
        status: "waiting",
      });
      await manager.cancelJob("cancel-1");
      const job = await Storage.get("jobs", "cancel-1");
      expect(job).toBeNull();
    });
  });

  describe("retryAllFailed()", () => {
    it("retries all failed jobs for a queue and returns count", async () => {
      for (let i = 0; i < 3; i++) {
        await Storage.save("jobs", `fail-${i}`, {
          id: `fail-${i}`,
          type: "task",
          queueName: "retry-all-q",
          status: "failed",
          data: {},
          opts: {},
          attemptMade: 3,
          progressPercent: 0,
          error: "boom",
          tags: [],
          createdAt: new Date(),
        });
      }

      const count = await manager.retryAllFailed("retry-all-q");
      expect(count).toBe(3);

      // Originals should still be "failed" (preserved for audit)
      for (let i = 0; i < 3; i++) {
        const job = await Storage.get<OqronJob>("jobs", `fail-${i}`);
        expect(job!.status).toBe("failed");
        expect(job!.retryReason).toBeDefined(); // Marked as retried
      }
    });

    it("returns 0 when no failed jobs exist", async () => {
      const count = await manager.retryAllFailed("empty-q");
      expect(count).toBe(0);
    });
  });

  // ── Pause / Resume ────────────────────────────────────────────────────────

  describe("pauseQueue() / resumeQueue()", () => {
    it("pause prevents broker claims", async () => {
      await Broker.publish("pq", "id1");
      await manager.pauseQueue("pq");

      const claimed = await Broker.claim("pq", "w1", 1, 5000);
      expect(claimed).toHaveLength(0);

      await manager.resumeQueue("pq");
      const claimed2 = await Broker.claim("pq", "w1", 1, 5000);
      expect(claimed2).toContain("id1");
    });
  });

  // ── Module Management ──────────────────────────────────────────────────────

  describe("Module Management", () => {
    it("listModules returns registered modules", () => {
      const modules = manager.listModules();
      expect(modules).toHaveLength(1);
      expect(modules[0]).toMatchObject({
        name: "queue",
        enabled: true,
        status: "active",
      });
    });

    it("enableModule returns false for unregistered module", async () => {
      const result = await manager.enableModule("nonexistent");
      expect(result).toBe(false);
    });

    it("enableModule returns true for already-enabled module", async () => {
      const result = await manager.enableModule("queue");
      expect(result).toBe(true);
    });

    it("disableModule stops a module", async () => {
      const mod = OqronRegistry.getInstance().get("queue")!;
      expect(mod.enabled).toBe(true);

      await manager.disableModule("queue");
      expect(mod.enabled).toBe(false);

      // Re-enable for remaining tests
      await manager.enableModule("queue");
    });

    it("disableModule returns false for unregistered module", async () => {
      const result = await manager.disableModule("ghost");
      expect(result).toBe(false);
    });

    it("triggerModule returns false when no module claims the schedule", async () => {
      const result = await manager.triggerModule("some-schedule");
      expect(result).toBe(false);
    });
  });

  // ── Job Queries ────────────────────────────────────────────────────────────

  describe("getJobsByType()", () => {
    it("filters jobs by type", async () => {
      await Storage.save("jobs", "cron-1", {
        id: "cron-1",
        type: "cron",
        queueName: "system_cron",
        status: "completed",
        data: {},
        opts: {},
        attemptMade: 1,
        progressPercent: 100,
        tags: [],
        createdAt: new Date(),
      });
      await Storage.save("jobs", "task-1", {
        id: "task-1",
        type: "task",
        queueName: "emails",
        status: "waiting",
        data: {},
        opts: {},
        attemptMade: 0,
        progressPercent: 0,
        tags: [],
        createdAt: new Date(),
      });

      const result = await manager.getJobsByType("cron");
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe("cron-1");
      expect(result.total).toBe(1);
    });

    it("supports status filter", async () => {
      await Storage.save("jobs", "cron-ok", {
        id: "cron-ok",
        type: "cron",
        status: "completed",
        queueName: "q",
        data: {},
        opts: {},
        attemptMade: 1,
        progressPercent: 100,
        tags: [],
        createdAt: new Date(),
      });
      await Storage.save("jobs", "cron-fail", {
        id: "cron-fail",
        type: "cron",
        status: "failed",
        queueName: "q",
        data: {},
        opts: {},
        attemptMade: 3,
        progressPercent: 0,
        tags: [],
        createdAt: new Date(),
      });

      const result = await manager.getJobsByType("cron", { status: "failed" });
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe("cron-fail");
    });
  });

  describe("getJobHistory()", () => {
    it("returns jobs matching scheduleId", async () => {
      await Storage.save("jobs", "run-1", {
        id: "run-1",
        type: "cron",
        queueName: "system_cron",
        scheduleId: "daily-report",
        status: "completed",
        data: {},
        opts: {},
        attemptMade: 1,
        progressPercent: 100,
        tags: [],
        createdAt: new Date(),
      });
      await Storage.save("jobs", "run-2", {
        id: "run-2",
        type: "cron",
        queueName: "system_cron",
        scheduleId: "daily-report",
        status: "failed",
        data: {},
        opts: {},
        attemptMade: 3,
        progressPercent: 0,
        tags: [],
        createdAt: new Date(),
      });

      const result = await manager.getJobHistory("daily-report");
      expect(result.jobs.length).toBeGreaterThanOrEqual(2);
      expect(result.total).toBeGreaterThanOrEqual(2);
    });
  });

  describe("getRetryChain()", () => {
    it("returns the full retry chain for a job", async () => {
      // Create original → retry1 → retry2
      await Storage.save<OqronJob>("jobs", "orig", {
        id: "orig",
        type: "task",
        queueName: "q",
        status: "failed",
        data: {},
        opts: {},
        attemptMade: 3,
        progressPercent: 0,
        tags: [],
        createdAt: new Date(),
        retryReason: "Retried as r1",
      });
      await Storage.save<OqronJob>("jobs", "r1", {
        id: "r1",
        type: "task",
        queueName: "q",
        status: "failed",
        retriedFromId: "orig",
        data: {},
        opts: {},
        attemptMade: 3,
        progressPercent: 0,
        tags: [],
        createdAt: new Date(),
        retryReason: "Retried as r2",
      });
      await Storage.save<OqronJob>("jobs", "r2", {
        id: "r2",
        type: "task",
        queueName: "q",
        status: "completed",
        retriedFromId: "r1",
        data: {},
        opts: {},
        attemptMade: 1,
        progressPercent: 100,
        tags: [],
        createdAt: new Date(),
      });

      const chain = await manager.getRetryChain("r2");
      expect(chain).toHaveLength(3);
      expect(chain.map((j) => j.id)).toEqual(["orig", "r1", "r2"]);
    });

    it("returns single-element chain for a job with no retries", async () => {
      await Storage.save<OqronJob>("jobs", "solo", {
        id: "solo",
        type: "task",
        queueName: "q",
        status: "completed",
        data: {},
        opts: {},
        attemptMade: 1,
        progressPercent: 100,
        tags: [],
        createdAt: new Date(),
      });

      const chain = await manager.getRetryChain("solo");
      expect(chain).toHaveLength(1);
      expect(chain[0].id).toBe("solo");
    });
  });
});
