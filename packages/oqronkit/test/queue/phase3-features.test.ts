import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OqronContainer } from "../../src/engine/container.js";
import { OqronEventBus } from "../../src/engine/events/event-bus.js";
import { createLogger } from "../../src/engine/logger/index.js";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";
import { MemoryLock } from "../../src/engine/memory/memory-lock.js";
import { MemoryStore } from "../../src/engine/memory/memory-store.js";
import { calculateBackoff } from "../../src/engine/utils/backoffs.js";
import { queue } from "../../src/queue/define-queue.js";
import { QueueEngine } from "../../src/queue/queue-engine.js";

describe("Phase 3 — P3 Nice-to-Haves", () => {
  const logger = createLogger({ enabled: false }, { module: "test" });

  beforeEach(() => {
    OqronContainer.init(new MemoryStore(), new MemoryBroker(), new MemoryLock(), {
      project: "test",
      environment: "test",
    });
  });

  afterEach(() => {
    OqronContainer.reset();
    OqronEventBus.removeAllListeners();
  });

  // ── F7: Custom Backoff Strategy ──────────────────────────────────────────

  describe("F7: Custom Backoff Strategy", () => {
    it("calculateBackoff supports custom strategy with backoffFn", () => {
      // Quadratic backoff: delay * attempt^2
      const quadratic = (attempt: number, baseDelay: number) =>
        baseDelay * attempt * attempt;

      const delay1 = calculateBackoff(
        { type: "custom", delay: 100, backoffFn: quadratic },
        1,
      );
      expect(delay1).toBe(100); // 100 * 1 * 1

      const delay2 = calculateBackoff(
        { type: "custom", delay: 100, backoffFn: quadratic },
        2,
      );
      expect(delay2).toBe(400); // 100 * 2 * 2

      const delay3 = calculateBackoff(
        { type: "custom", delay: 100, backoffFn: quadratic },
        3,
      );
      expect(delay3).toBe(900); // 100 * 3 * 3
    });

    it("custom backoff respects maxDelay cap", () => {
      const quadratic = (attempt: number, baseDelay: number) =>
        baseDelay * attempt * attempt;

      const delay = calculateBackoff(
        { type: "custom", delay: 100, backoffFn: quadratic },
        10,
        5000,
      );
      expect(delay).toBe(5000); // Capped at maxDelay (10000 > 5000)
    });

    it("throws when custom strategy lacks backoffFn", () => {
      expect(() =>
        calculateBackoff({ type: "custom", delay: 100 }, 1),
      ).toThrow(/backoffFn/);
    });

    it("uses custom backoff in queue handler retry", async () => {
      let attempts = 0;

      const q = queue<{ x: number }>({
        name: "custom-backoff-q",
        retries: {
          max: 2,
          strategy: "custom",
          baseDelay: 50,
          backoffFn: (attempt, base) => base * attempt,
        },
        handler: async () => {
          attempts++;
          throw new Error("fail");
        },
      });

      await q.add({ x: 1 });

      const engine = new QueueEngine(
        { project: "test", environment: "test" },
        logger,
        { module: "queue", heartbeatMs: 50 },
      );
      await engine.init();
      await engine.start();
      await new Promise((r) => setTimeout(r, 2000));
      await engine.stop();

      // Should have attempted at least the initial + retries
      expect(attempts).toBeGreaterThanOrEqual(2);
    });
  });

  // ── F10: jitterMs ─────────────────────────────────────────────────────────

  describe("F10: jitterMs for Poll Intervals", () => {
    it("accepts jitterMs config without errors", async () => {
      queue<{ x: number }>({
        name: "jitter-q",
        pollIntervalMs: 100,
        jitterMs: 50,
        handler: async () => {},
      });

      const engine = new QueueEngine(
        { project: "test", environment: "test" },
        logger,
        { module: "queue", heartbeatMs: 100 },
      );
      await engine.init();
      await engine.start();
      // If jitterMs is wired correctly, the engine starts without errors
      await new Promise((r) => setTimeout(r, 200));
      await engine.stop();
    });
  });

  // ── C3: getProgress ─────────────────────────────────────────────────────────

  describe("C3: getProgress on Context", () => {
    it("ctx.getProgress() returns current progress value", async () => {
      let progressBeforeUpdate = -1;
      let progressAfterUpdate = -1;

      const q = queue<{ x: number }>({
        name: "getprogress-q",
        handler: async (ctx) => {
          progressBeforeUpdate = ctx.getProgress();
          await ctx.progress(42, "halfway");
          progressAfterUpdate = ctx.getProgress();
        },
      });

      await q.add({ x: 1 });

      const engine = new QueueEngine(
        { project: "test", environment: "test" },
        logger,
        { module: "queue", heartbeatMs: 50 },
      );
      await engine.init();
      await engine.start();
      await new Promise((r) => setTimeout(r, 500));
      await engine.stop();

      expect(progressBeforeUpdate).toBe(0);
      expect(progressAfterUpdate).toBe(42);
    });
  });
});
