import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { OqronKit, queue } from "../../src/index.js";
import { OqronEventBus, OqronRegistry } from "../../src/engine/index.js";

describe("Server-Dependent module: Queue", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await OqronKit.stop();
    OqronRegistry.getInstance()._reset();
  });

  it("should process jobs synchronously in a monolithic loop", async () => {
    let fired = false;

    const myQueue = queue<{ msg: string }, string>({
      name: "msg-queue-1",
      handler: async (job) => {
        fired = true;
        expect(job.data.msg).toBe("hi");
        return "perfect";
      },
    });

    // Re-init so the registry catches the dynamic queue instantiation
    await OqronKit.init({
      config: {
        environment: "test",
        project: "test-proj",
        modules: ["queue"],
      },
    });

    const result = await myQueue.add({ msg: "hi" });
    expect(result.status).toBe("waiting");

    // Advance the internal poller (5000ms heartbeat)
    await vi.advanceTimersByTimeAsync(100);

    expect(fired).toBe(true);
  });

  it("should enforce parallel concurrency caps", async () => {
    let active = 0;
    let maxFound = 0;

    const myQueue = queue({
      name: "concurrent-cap",
      concurrency: 2, // strictly 2 maximum at once
      handler: async () => {
        active++;
        maxFound = Math.max(maxFound, active);
        await new Promise((r) => setTimeout(r, 50));
        active--;
      },
    });

    await OqronKit.init({
      config: {
        environment: "test",
        project: "test-proj",
        modules: ["queue"],
      },
    });

    // Spam 5 jobs
    for (let i = 0; i < 5; i++) {
      await myQueue.add({ idx: i });
    }

    // Flush timers carefully to let parallel executing blocks jump
    await vi.advanceTimersByTimeAsync(200);

    expect(maxFound).toBe(2);
    expect(active).toBe(0);
  });

  it("should broadcast standard execution events", async () => {
    const successSpy = vi.fn();
    OqronEventBus.on("job:success", successSpy);

    const q = queue({
      name: "event-q",
      handler: async () => "result payload",
    });

    await OqronKit.init({
      config: {
        environment: "test",
        project: "test-proj",
        modules: ["queue"],
      },
    });

    const job = await q.add({});
    await vi.advanceTimersByTimeAsync(50);

    expect(successSpy).toHaveBeenCalledWith("event-q", job.id);
  });
});
