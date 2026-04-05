import { describe, it, expect, beforeEach } from "vitest";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";

describe("Broker Ordering Strategy", () => {
  let broker: MemoryBroker;

  beforeEach(() => {
    broker = new MemoryBroker();
  });

  describe("FIFO (default)", () => {
    it("should claim jobs in insertion order", async () => {
      await broker.publish("q", "a");
      await broker.publish("q", "b");
      await broker.publish("q", "c");

      const claimed = await broker.claim("q", "w1", 3, 30000, "fifo");
      expect(claimed).toEqual(["a", "b", "c"]);
    });
  });

  describe("LIFO", () => {
    it("should claim the most recently added job first", async () => {
      await broker.publish("q", "a");
      await broker.publish("q", "b");
      await broker.publish("q", "c");

      const claimed = await broker.claim("q", "w1", 3, 30000, "lifo");
      expect(claimed).toEqual(["c", "b", "a"]);
    });

    it("should still claim only available items", async () => {
      await broker.publish("q", "a");
      await broker.publish("q", "b");

      const claimed = await broker.claim("q", "w1", 5, 30000, "lifo");
      expect(claimed).toEqual(["b", "a"]);
    });
  });

  describe("Priority", () => {
    it("should claim lowest priority number first", async () => {
      await broker.publish("q", "low", undefined, 10);
      await broker.publish("q", "high", undefined, 1);
      await broker.publish("q", "medium", undefined, 5);

      const claimed = await broker.claim("q", "w1", 3, 30000, "priority");
      expect(claimed).toEqual(["high", "medium", "low"]);
    });

    it("should handle same-priority items in insertion order", async () => {
      await broker.publish("q", "a", undefined, 1);
      await broker.publish("q", "b", undefined, 1);
      await broker.publish("q", "c", undefined, 1);

      const claimed = await broker.claim("q", "w1", 3, 30000, "priority");
      expect(claimed).toEqual(["a", "b", "c"]);
    });

    it("should claim partial limit from priority queue", async () => {
      await broker.publish("q", "low", undefined, 10);
      await broker.publish("q", "high", undefined, 1);
      await broker.publish("q", "medium", undefined, 5);

      // Only claim 2
      const claimed = await broker.claim("q", "w1", 2, 30000, "priority");
      expect(claimed).toEqual(["high", "medium"]);

      // Remaining should still be available
      const remaining = await broker.claim("q", "w2", 1, 30000, "priority");
      expect(remaining).toEqual(["low"]);
    });
  });

  describe("Default strategy", () => {
    it("should default to FIFO when no strategy is specified", async () => {
      await broker.publish("q", "a");
      await broker.publish("q", "b");

      const claimed = await broker.claim("q", "w1", 2, 30000);
      expect(claimed).toEqual(["a", "b"]);
    });
  });
});
