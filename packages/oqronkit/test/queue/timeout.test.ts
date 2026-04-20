import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OqronContainer } from "../../src/engine/container.js";
import { createLogger } from "../../src/engine/logger/index.js";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";
import { MemoryLock } from "../../src/engine/memory/memory-lock.js";
import { MemoryStore } from "../../src/engine/memory/memory-store.js";
import { queue } from "../../src/queue/define-queue.js";
import { QueueEngine } from "../../src/queue/queue-engine.js";

describe("QueueEngine — Timeout Enforcement", () => {
  const logger = createLogger({ enabled: false }, { module: "test" });

  beforeEach(() => {
    OqronContainer.init(new MemoryStore(), new MemoryBroker(), new MemoryLock(), {
      project: "test",
      environment: "test",
    });
  });

  afterEach(() => {
    OqronContainer.reset();
  });

  it("aborts a job that exceeds the configured timeout", async () => {
    let wasAborted = false;

    const q = queue<{ x: number }>({
      name: "q-timeout",
      timeout: 100, // 100ms timeout
      handler: async (ctx) => {
        ctx.signal.addEventListener("abort", () => {
          wasAborted = true;
        });
        await new Promise((r) => setTimeout(r, 1000));
      },
    });

    const job = await q.add({ x: 1 });

    const engine = new QueueEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "queue", heartbeatMs: 50 },
    );
    await engine.init();
    await engine.start();
    await new Promise((r) => setTimeout(r, 500));
    await engine.stop();

    expect(wasAborted).toBe(true);

    const di = OqronContainer.get();
    const finalJob = await di.storage.get<any>("jobs", job.id);
    expect(finalJob.status).toBe("failed");
    expect(finalJob.error).toContain("timeout");
  });

  it("timeout error message includes configured duration", async () => {
    const q = queue<{ x: number }>({
      name: "q-timeout-msg",
      timeout: 150,
      handler: async () => {
        await new Promise((r) => setTimeout(r, 1000));
      },
    });

    const job = await q.add({ x: 1 });

    const engine = new QueueEngine(
      { project: "test", environment: "test" },
      logger,
      { module: "queue", heartbeatMs: 50 },
    );
    await engine.init();
    await engine.start();
    await new Promise((r) => setTimeout(r, 500));
    await engine.stop();

    const di = OqronContainer.get();
    const finalJob = await di.storage.get<any>("jobs", job.id);
    expect(finalJob.error).toContain("150ms");
  });
});
