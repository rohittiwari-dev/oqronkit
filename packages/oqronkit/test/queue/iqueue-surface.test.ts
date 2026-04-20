import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OqronContainer } from "../../src/engine/container.js";
import { OqronEventBus } from "../../src/engine/events/event-bus.js";
import { createLogger } from "../../src/engine/logger/index.js";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";
import { MemoryLock } from "../../src/engine/memory/memory-lock.js";
import { MemoryStore } from "../../src/engine/memory/memory-store.js";
import { queue } from "../../src/queue/define-queue.js";
import type { OqronJob } from "../../src/engine/types/job.types.js";

describe("IQueue Surface — addBulk, getJob, getJobs, count, pause, resume, obliterate", () => {
  beforeEach(() => {
    const store = new MemoryStore();
    const broker = new MemoryBroker();
    const lock = new MemoryLock();
    OqronContainer.init(store, broker, lock, {
      project: "test",
      environment: "test",
    });
  });

  afterEach(() => {
    OqronContainer.reset();
    OqronEventBus.removeAllListeners();
  });

  it("addBulk pushes multiple jobs at once", async () => {
    const q = queue<{ idx: number }>({
      name: "bulk-q",
      handler: async () => {},
    });

    const results = await q.addBulk([
      { data: { idx: 1 } },
      { data: { idx: 2 } },
      { data: { idx: 3 } },
    ]);

    expect(results).toHaveLength(3);
    expect(results[0].data.idx).toBe(1);
    expect(results[2].data.idx).toBe(3);
  });

  it("getJob retrieves a specific job and guards queueName", async () => {
    const q = queue<{ msg: string }>({
      name: "getjob-q",
      handler: async () => {},
    });

    const job = await q.add({ msg: "hello" });
    const found = await q.getJob(job.id);
    expect(found).toBeDefined();
    expect(found!.data.msg).toBe("hello");

    // Non-existent job
    const ghost = await q.getJob("non-existent-id");
    expect(ghost).toBeNull();
  });

  it("getJobs lists jobs with optional status filter", async () => {
    const q = queue({
      name: "getjobs-q",
      handler: async () => {},
    });

    await q.add({ a: 1 });
    await q.add({ a: 2 });
    await q.add({ a: 3 });

    const all = await q.getJobs();
    expect(all.length).toBe(3);

    const waiting = await q.getJobs({ status: "waiting" });
    expect(waiting.length).toBe(3);

    const completed = await q.getJobs({ status: "completed" });
    expect(completed.length).toBe(0);
  });

  it("count returns the number of jobs in the queue", async () => {
    const q = queue({
      name: "count-q",
      handler: async () => {},
    });

    expect(await q.count()).toBe(0);

    await q.add({ x: 1 });
    await q.add({ x: 2 });

    expect(await q.count()).toBe(2);
    expect(await q.count("waiting")).toBe(2);
    expect(await q.count("completed")).toBe(0);
  });

  it("pause/resume/isPaused work correctly", async () => {
    const q = queue({
      name: "pause-q",
      handler: async () => {},
    });

    expect(await q.isPaused()).toBe(false);

    await q.pause();
    expect(await q.isPaused()).toBe(true);

    await q.resume();
    expect(await q.isPaused()).toBe(false);
  });

  it("obliterate removes all jobs for the queue", async () => {
    const q = queue({
      name: "obliterate-q",
      handler: async () => {},
    });

    await q.add({ x: 1 });
    await q.add({ x: 2 });
    await q.add({ x: 3 });

    expect(await q.count()).toBe(3);

    const spy = vi.fn();
    OqronEventBus.on("queue:obliterated", spy);

    const removed = await q.obliterate();
    expect(removed).toBe(3);
    expect(await q.count()).toBe(0);
    expect(spy).toHaveBeenCalledWith("obliterate-q", 3);
  });

  it("pause emits queue:paused and resume emits queue:resumed", async () => {
    const q = queue({
      name: "emit-q",
      handler: async () => {},
    });

    const pauseSpy = vi.fn();
    const resumeSpy = vi.fn();
    OqronEventBus.on("queue:paused", pauseSpy);
    OqronEventBus.on("queue:resumed", resumeSpy);

    await q.pause();
    expect(pauseSpy).toHaveBeenCalledWith("emit-q");

    await q.resume();
    expect(resumeSpy).toHaveBeenCalledWith("emit-q");
  });
});
