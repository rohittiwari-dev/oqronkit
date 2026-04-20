import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OqronContainer } from "../../src/engine/container.js";
import { OqronEventBus } from "../../src/engine/events/event-bus.js";
import { createLogger } from "../../src/engine/logger/index.js";
import { CrossNodeStallScanner } from "../../src/engine/lock/cross-node-stall-scanner.js";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";
import { MemoryLock } from "../../src/engine/memory/memory-lock.js";
import { MemoryStore } from "../../src/engine/memory/memory-store.js";
import type { OqronJob } from "../../src/engine/types/job.types.js";

describe("F9: CrossNodeStallScanner", () => {
  const logger = createLogger({ enabled: false }, { module: "test" });
  let store: MemoryStore;
  let lock: MemoryLock;

  beforeEach(() => {
    store = new MemoryStore();
    lock = new MemoryLock();
    OqronContainer.init(store, new MemoryBroker(), lock, {
      project: "test",
      environment: "test",
    });
  });

  afterEach(() => {
    OqronContainer.reset();
    OqronEventBus.removeAllListeners();
  });

  it("detects stalled jobs whose lock has expired", async () => {
    // Seed an active job in storage with a workerId
    const job: OqronJob = {
      id: "stall-test-1",
      type: "task",
      queueName: "test-q",
      status: "active",
      workerId: "dead-worker-001",
      data: { x: 1 },
      opts: {},
      attemptMade: 1,
      progressPercent: 0,
      tags: [],
      createdAt: new Date(),
      startedAt: new Date(Date.now() - 60000), // Started 60s ago
    };
    await store.save("jobs", job.id, job);

    // No lock exists for this job — the worker has crashed
    // (We intentionally do NOT acquire a lock)

    const stalledJobs: OqronJob[] = [];
    const scanner = new CrossNodeStallScanner(store, lock, logger, {
      lockPrefix: "queue",
    });

    const count = await scanner.scan("queue", async (j) => {
      stalledJobs.push(j);
    });

    expect(count).toBe(1);
    expect(stalledJobs.length).toBe(1);
    expect(stalledJobs[0].id).toBe("stall-test-1");
    expect(stalledJobs[0].status).toBe("stalled");
    expect(stalledJobs[0].stalledCount).toBe(1);
  });

  it("skips jobs with valid locks", async () => {
    const job: OqronJob = {
      id: "valid-lock-job",
      type: "task",
      queueName: "test-q",
      status: "active",
      workerId: "alive-worker-001",
      data: {},
      opts: {},
      attemptMade: 1,
      progressPercent: 0,
      tags: [],
      createdAt: new Date(),
    };
    await store.save("jobs", job.id, job);

    // Acquire a valid lock for this job
    await lock.acquire("queue:job:valid-lock-job", "alive-worker-001", 30000);

    const stalledJobs: OqronJob[] = [];
    const scanner = new CrossNodeStallScanner(store, lock, logger, {
      lockPrefix: "queue",
    });

    const count = await scanner.scan("queue", async (j) => {
      stalledJobs.push(j);
    });

    expect(count).toBe(0);
    expect(stalledJobs.length).toBe(0);
  });

  it("marks job as permanently failed after exceeding maxStalledCount", async () => {
    const job: OqronJob = {
      id: "max-stall-job",
      type: "task",
      queueName: "test-q",
      status: "active",
      workerId: "dead-worker-002",
      data: {},
      opts: {},
      attemptMade: 1,
      progressPercent: 0,
      stalledCount: 2, // Already stalled twice
      tags: [],
      createdAt: new Date(),
    };
    await store.save("jobs", job.id, job);

    const scanner = new CrossNodeStallScanner(store, lock, logger, {
      lockPrefix: "queue",
      maxStalledCount: 3,
    });

    await scanner.scan("queue", async () => {});

    const updated = await store.get<OqronJob>("jobs", "max-stall-job");
    expect(updated!.status).toBe("failed");
    expect(updated!.stalledCount).toBe(3);
    expect(updated!.error).toContain("maxStalledCount");
    expect(updated!.finishedAt).toBeDefined();
  });

  it("skips jobs without a workerId", async () => {
    const job: OqronJob = {
      id: "no-worker-job",
      type: "task",
      queueName: "test-q",
      status: "active",
      // No workerId — not yet claimed by a worker
      data: {},
      opts: {},
      attemptMade: 0,
      progressPercent: 0,
      tags: [],
      createdAt: new Date(),
    };
    await store.save("jobs", job.id, job);

    const scanner = new CrossNodeStallScanner(store, lock, logger, {
      lockPrefix: "queue",
    });

    const count = await scanner.scan("queue", async () => {});
    expect(count).toBe(0);
  });

  it("filters by queueNames when configured", async () => {
    // Two active jobs in different queues, both stalled
    const job1: OqronJob = {
      id: "q1-job",
      type: "task",
      queueName: "queue-a",
      status: "active",
      workerId: "dead",
      data: {},
      opts: {},
      attemptMade: 1,
      progressPercent: 0,
      tags: [],
      createdAt: new Date(),
    };
    const job2: OqronJob = {
      id: "q2-job",
      type: "task",
      queueName: "queue-b",
      status: "active",
      workerId: "dead",
      data: {},
      opts: {},
      attemptMade: 1,
      progressPercent: 0,
      tags: [],
      createdAt: new Date(),
    };
    await store.save("jobs", job1.id, job1);
    await store.save("jobs", job2.id, job2);

    const scanner = new CrossNodeStallScanner(store, lock, logger, {
      lockPrefix: "queue",
      queueNames: ["queue-a"], // Only scan queue-a
    });

    const stalledJobs: string[] = [];
    const count = await scanner.scan("queue", async (j) => {
      stalledJobs.push(j.id);
    });

    expect(count).toBe(1);
    expect(stalledJobs).toContain("q1-job");
    expect(stalledJobs).not.toContain("q2-job");
  });

  it("start/stop lifecycle works correctly", async () => {
    const scanner = new CrossNodeStallScanner(store, lock, logger, {
      intervalMs: 100,
    });

    scanner.start(async () => {});
    expect(scanner.isScanning).toBe(false); // Not scanning yet (first tick hasn't fired)

    // Wait for one tick
    await new Promise((r) => setTimeout(r, 200));
    scanner.stop();

    // Should not throw after stopping
    expect(() => scanner.stop()).not.toThrow();
  });
});
