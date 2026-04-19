import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { SchedulerModule } from "../../src/scheduler/cron-engine.js";
import { MemoryStore } from "../../src/engine/memory/memory-store.js";
import { MemoryLock } from "../../src/engine/memory/memory-lock.js";
import { createLogger, OqronEventBus } from "../../src/engine/index.js";

const logger = createLogger({ level: "error" }, { module: "cron-engine-test" });

describe("CronEngine", () => {
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
  });

  describe("Lifecycle and init()", () => {
    it("initializes schedules and computes nextRunAt", async () => {
      const module = new SchedulerModule(
        [
          {
            name: "test-cron",
            expression: "*/5 * * * *",
            handler: async () => {},
          },
        ],
        logger,
        "test",
        "default",
        {},
        container,
      );

      await module.init();

      const saved = await storage.get<any>("schedules", "test-cron");
      expect(saved).toBeDefined();
      expect(saved.nextRunAt).toBeDefined();
    });

    it("does not overwrite nextRunAt if it already exists", async () => {
      const future = new Date(Date.now() + 100000);
      await storage.save("schedules", "existing", {
        name: "existing",
        expression: "*/5 * * * *",
        nextRunAt: future,
      });

      const module = new SchedulerModule(
        [
          {
            name: "existing",
            expression: "*/5 * * * *",
            handler: async () => {},
          },
        ],
        logger,
        "test",
        "default",
        {},
        container,
      );

      await module.init();

      const saved = await storage.get<any>("schedules", "existing");
      expect(new Date(saved.nextRunAt).getTime()).toBe(future.getTime());
    });
  });

  describe("tick() logic", () => {
    it("skips tick if disabled", async () => {
      const module = new SchedulerModule([], logger, "test", "default", {}, container);
      await module.init();
      module.enabled = false;
      const tickSpy = vi.spyOn(module as any, "handleLeaderInit");
      
      await (module as any).tick();
      expect(tickSpy).not.toHaveBeenCalled();
    });

    it("runs handleLeaderInit on first tick", async () => {
      const module = new SchedulerModule([], logger, "test", "default", { leaderElection: false }, container);
      const initSpy = vi.spyOn(module as any, "handleLeaderInit");
      
      await (module as any).tick();
      expect(initSpy).toHaveBeenCalledTimes(1);

      await (module as any).tick();
      expect(initSpy).toHaveBeenCalledTimes(1); // Not called again
    });

    it("checks cluster stalls occasionally", async () => {
      const module = new SchedulerModule([], logger, "test", "default", { leaderElection: false }, container);
      const stallSpy = vi.spyOn(module as any, "detectClusterStalls");
      
      // Deterministic: fires every 10th tick
      for (let i = 0; i < 9; i++) {
        await (module as any).tick();
      }
      expect(stallSpy).not.toHaveBeenCalled();

      await (module as any).tick(); // 10th tick
      expect(stallSpy).toHaveBeenCalledTimes(1);
    });

    it("fires due cron and updates nextRunAt", async () => {
      const now = Date.now();
      const past = new Date(now - 1000);
      
      await storage.save("schedules", "due-cron", {
        name: "due-cron",
        nextRunAt: past,
      });

      let fired = false;
      const module = new SchedulerModule(
        [
          {
            name: "due-cron",
            expression: "0 0 * * *", // next run will be computed forward
            handler: async () => { fired = true; },
          },
        ],
        logger,
        "test",
        "default",
        { leaderElection: false },
        container,
      );

      await (module as any).tick();
      
      // Need to flush microtasks to let the fire() method acquire the lock and add to activeJobs
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(fired).toBe(true);
      const saved = await storage.get<any>("schedules", "due-cron");
      // nextRunAt should have advanced
      expect(new Date(saved.nextRunAt).getTime()).toBeGreaterThan(past.getTime());
    });

    it("handles disabled hold behavior on tick", async () => {
      const now = Date.now();
      const past = new Date(now - 1000);
      
      await storage.save("schedules", "hold-cron", {
        name: "hold-cron",
        nextRunAt: past,
        paused: true,
      });

      let fired = false;
      const module = new SchedulerModule(
        [
          {
            name: "hold-cron",
            expression: "0 0 * * *",
            disabledBehavior: "hold",
            handler: async () => { fired = true; },
          },
        ],
        logger,
        "test",
        "default",
        { leaderElection: false },
        container,
      );

      await (module as any).tick();
      
      expect(fired).toBe(false);
      const jobs = await storage.list<any>("jobs");
      expect(jobs.length).toBe(1);
      expect(jobs[0].status).toBe("paused");
      expect(jobs[0].pausedReason).toBe("disabled-hold");
    });
  });

  describe("fire() execution", () => {
    it("handles handler success and saves telemetry", async () => {
      const module = new SchedulerModule(
        [
          {
            name: "success-cron",
            intervalMs: 60000,
            handler: async () => { return "done"; },
          },
        ],
        logger,
        "test",
        "default",
        {},
        container,
      );

      await (module as any).fire(module["schedules"][0]);
      
      // Since fire() wraps the promise and leaves it active, we wait for it
      const activeJobs = module["activeJobs"].values();
      for (const job of activeJobs) {
         if (job.promise) await job.promise;
      }
      
      const jobs = await storage.list<any>("jobs");
      expect(jobs.length).toBe(1);
      expect(jobs[0].status).toBe("completed");
      expect(jobs[0].returnValue).toBe("done");
    });

    it("handles maxConcurrent correctly", async () => {
      let activeHandlers = 0;
      let hitMax = false;
      const def = {
        name: "concurrent-cron",
        maxConcurrent: 1,
        intervalMs: 10000,
        handler: async () => {
          activeHandlers++;
          if (activeHandlers > 1) hitMax = true;
          await new Promise(r => setTimeout(r, 100)); // stay active
          activeHandlers--;
        },
      };

      const module = new SchedulerModule([def], logger, "test", "default", {}, container);

      // Fire first one and let it acquire the lock and register in activeJobs
      const p1 = (module as any).fire(def);
      await Promise.resolve();
      await Promise.resolve();

      // Fire second one - it should hit maxConcurrent synchronously based on activeJobs
      const p2 = (module as any).fire(def);
      await Promise.resolve();
      await Promise.resolve();

      const activeJobs = Array.from(module["activeJobs"].values());
      expect(activeJobs.length).toBe(1); // Second fire should return early
      const promises = activeJobs.map(j => j.promise);
      
      vi.advanceTimersByTime(200);
      await Promise.all(promises);
      expect(hitMax).toBe(false);
    });

    it("runs retries on failure", async () => {
      let attempts = 0;
      const def = {
        name: "retry-cron",
        intervalMs: 10000,
        retries: { max: 2, baseDelay: 10, strategy: "fixed" as const },
        handler: async () => {
          attempts++;
          throw new Error("fail");
        },
      };

      const module = new SchedulerModule([def], logger, "test", "default", {}, container);

      const firePromise = (module as any).fire(def);
      
      // flush to get activeJob
      await Promise.resolve();
      await Promise.resolve();
      
      const activeJobs = Array.from(module["activeJobs"].values());
      const jobPromise = activeJobs[0]?.promise;
      
      // Need to advance timers for retries
      // The sleep is: await new Promise(resolve => setTimeout(resolve, delay));
      // First retry delay is 10, second is 20
      for(let i=0; i<3; i++) {
         vi.advanceTimersByTime(50);
         await Promise.resolve();
         await Promise.resolve();
      }
      
      if (jobPromise) await jobPromise;
      await firePromise;

      expect(attempts).toBe(3); // 1 initial + 2 retries
      const jobs = await storage.list<any>("jobs");
      expect(jobs[0].status).toBe("failed");
      expect(jobs[0].error).toBe("fail");
    });
  });

  describe("fire() execution — edge cases and hooks", () => {
    it("handles overlap: 'skip' behavior", async () => {
      const def = {
        name: "overlap-skip-cron",
        overlap: "skip" as const,
        intervalMs: 10000,
        handler: async () => {
           await new Promise(r => setTimeout(r, 100));
        },
      };

      const module = new SchedulerModule([def], logger, "test", "default", {}, container);

      const p1 = (module as any).fire(def);
      await Promise.resolve();
      await Promise.resolve();

      // Second fire should immediately return because the lockKey exists in activeJobs
      const p2 = (module as any).fire(def);
      await Promise.resolve();
      await Promise.resolve();

      const activeJobs = Array.from(module["activeJobs"].values());
      expect(activeJobs.length).toBe(1);

      vi.advanceTimersByTime(200);
      await Promise.all(activeJobs.map((j: any) => j.promise));
    });

    it("handles timeout correctly", async () => {
      const def = {
        name: "timeout-cron",
        intervalMs: 10000,
        timeout: 50,
        handler: async () => {
           await new Promise(r => setTimeout(r, 200));
        },
      };

      const module = new SchedulerModule([def], logger, "test", "default", {}, container);

      void (module as any).fire(def);
      await Promise.resolve();
      await Promise.resolve();
      
      const activeJobs = Array.from(module["activeJobs"].values());
      
      await vi.advanceTimersByTimeAsync(250);
      
      await Promise.all(activeJobs.map((j: any) => j.promise));

      const jobs = await storage.list<any>("jobs");
      expect(jobs[0].status).toBe("failed");
      expect(jobs[0].error).toContain("timed out");
    });

    it("executes hooks (beforeRun, afterRun, onError)", async () => {
      const steps: string[] = [];
      const def = {
        name: "hooks-cron",
        intervalMs: 10000,
        hooks: {
          beforeRun: async () => { steps.push("before"); },
          afterRun: async () => { steps.push("after"); },
          onError: async () => { steps.push("error"); return true; },
        },
        handler: async () => {
           steps.push("handler");
           throw new Error("fail");
        },
      };

      const module = new SchedulerModule([def], logger, "test", "default", {}, container);
      void (module as any).fire(def);
      
      await Promise.resolve();
      await Promise.resolve();
      
      const activeJobs = Array.from(module["activeJobs"].values());
      await Promise.all(activeJobs.map((j: any) => j.promise));
      
      expect(steps).toEqual(["before", "handler", "error"]);
    });

    it("supports context onProgress and onLog", async () => {
      let runCtx: any;
      const def = {
        name: "progress-cron",
        intervalMs: 10000,
        handler: async (ctx: any) => {
           runCtx = ctx;
           ctx.log.info("test log");
           await ctx.progress(50, "halfway");
           return "done";
        },
      };

      const module = new SchedulerModule([def], logger, "test", "default", {}, container);
      void (module as any).fire(def);
      
      await Promise.resolve();
      await Promise.resolve();
      
      const activeJobs = Array.from(module["activeJobs"].values());
      await Promise.all(activeJobs.map((j: any) => j.promise));
      
      const jobs = await storage.list<any>("jobs");
      expect(jobs[0].progressPercent).toBe(100);
      expect(jobs[0].logs.some((l: any) => l.msg === "test log")).toBe(true);
      expect(jobs[0].timeline.some((t: any) => t.reason.includes("halfway"))).toBe(true);
    });

    it("uses HeartbeatWorker when guaranteedWorker: true", async () => {
      const def = {
        name: "guaranteed-cron",
        intervalMs: 10000,
        guaranteedWorker: true,
        handler: async () => {},
      };

      const module = new SchedulerModule([def], logger, "test", "default", {}, container);
      
      const workerStartSpy = vi.spyOn((module as any).di.lock, "acquire");
      
      void (module as any).fire(def);
      
      await Promise.resolve();
      await Promise.resolve();
      
      const activeJobs = Array.from(module["activeJobs"].values());
      expect((activeJobs[0] as any).worker).toBeDefined();
      
      await Promise.all(activeJobs.map((j: any) => j.promise));
    });
  });

  describe("stop() and hooks", () => {
    it("stop() cleans up timers and jobs", async () => {
        const module = new SchedulerModule([], logger, "test", "default", {}, container);
        await module.start();
        expect(module["tickTimer"]).toBeDefined();
        await module.stop();
    });

    it("triggerManual() fires definition asynchronously", async () => {
        const def = {
          name: "manual-cron",
          intervalMs: 10000,
          handler: async () => {},
        };
        const module = new SchedulerModule([def], logger, "test", "default", {}, container);
        const fired = await module.triggerManual("manual-cron");
        expect(fired).toBe(true);
        const noExist = await module.triggerManual("unknown");
        expect(noExist).toBe(false);
    });

    it("enable() and disable() functions", async () => {
       const module = new SchedulerModule([], logger, "test", "default", {}, container);
       await module.disable();
       expect(module.enabled).toBe(false);
       await module.enable();
       expect(module.enabled).toBe(true);
    });
  });
});
