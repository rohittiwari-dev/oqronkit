import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initEngine, Storage } from "../../src/engine/core.js";
import { OqronEventBus } from "../../src/engine/events/event-bus.js";
import { QueueEvents } from "../../src/queue/queue-events.js";

describe("QueueEvents — Event Forwarding", () => {
  let events: QueueEvents;

  beforeEach(async () => {
    await initEngine({ project: "test", environment: "test" });
    events = new QueueEvents("my-queue");
  });

  afterEach(() => {
    events.close();
    OqronEventBus.removeAllListeners();
  });

  it("emits 'active' when a job starts on the matching queue", () => {
    const received: any[] = [];
    events.on("active", (data) => received.push(data));

    OqronEventBus.emit("job:start", "my-queue", "job-1", "taskQueue");

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ jobId: "job-1", prev: "waiting" });
  });

  it("does NOT emit 'active' for a different queue", () => {
    const received: any[] = [];
    events.on("active", (data) => received.push(data));

    OqronEventBus.emit("job:start", "other-queue", "job-1", "taskQueue");

    expect(received).toHaveLength(0);
  });

  it("emits 'progress' with data value", () => {
    const received: any[] = [];
    events.on("progress", (data) => received.push(data));

    OqronEventBus.emit("job:progress", "my-queue", "job-1", 75);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ jobId: "job-1", data: 75 });
  });

  it("emits 'completed' on job:success", async () => {
    const received: any[] = [];
    events.on("completed", (data) => received.push(data));

    OqronEventBus.emit("job:success", "my-queue", "job-1");

    // handler is async, need a tick
    await new Promise((r) => setTimeout(r, 10));

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ jobId: "job-1", prev: "active" });
  });

  it("emits 'completed' with returnvalue from storage", async () => {
    await Storage.save("jobs", "job-rv", { returnValue: { result: 42 } });

    const received: any[] = [];
    events.on("completed", (data) => received.push(data));

    OqronEventBus.emit("job:success", "my-queue", "job-rv");
    await new Promise((r) => setTimeout(r, 10));

    expect(received).toHaveLength(1);
    expect(received[0].returnvalue).toEqual({ result: 42 });
  });

  it("emits 'failed' with failedReason", () => {
    const received: any[] = [];
    events.on("failed", (data) => received.push(data));

    OqronEventBus.emit("job:fail", "my-queue", "job-1", new Error("timeout"));

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      jobId: "job-1",
      failedReason: "timeout",
      prev: "active",
    });
  });

  it("close() stops all event forwarding", () => {
    const received: any[] = [];
    events.on("active", (data) => received.push(data));

    events.close();
    OqronEventBus.emit("job:start", "my-queue", "job-1", "taskQueue");

    expect(received).toHaveLength(0);
  });

  it("multiple QueueEvents instances filter independently", () => {
    const events2 = new QueueEvents("other-queue");
    const r1: any[] = [];
    const r2: any[] = [];

    events.on("active", (d) => r1.push(d));
    events2.on("active", (d) => r2.push(d));

    OqronEventBus.emit("job:start", "my-queue", "j1", "mod");
    OqronEventBus.emit("job:start", "other-queue", "j2", "mod");

    expect(r1).toHaveLength(1);
    expect(r1[0].jobId).toBe("j1");
    expect(r2).toHaveLength(1);
    expect(r2[0].jobId).toBe("j2");

    events2.close();
  });
});
