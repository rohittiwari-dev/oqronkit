import { describe, expect, it, beforeEach } from "vitest";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";

describe("MemoryBroker Engine", () => {
  let broker: MemoryBroker;

  beforeEach(() => {
    broker = new MemoryBroker();
  });

  describe("signaling and claiming", () => {
    it("should signal enqueue and allow a worker to claim IDs", async () => {
      await broker.publish("test-q", "job-123");

      const claimed = await broker.claim("test-q", "worker-1", 1, 30000);
      expect(claimed.length).toBe(1);
      expect(claimed[0]).toBe("job-123");
    });

    it("should respect limits", async () => {
      await broker.publish("test-q", "j1");
      await broker.publish("test-q", "j2");

      const claimed = await broker.claim("test-q", "worker-1", 1, 30000);
      expect(claimed.length).toBe(1);
    });
  });

  describe("locks and acks", () => {
    it("should allow extending locks", async () => {
      await broker.publish("test-q", "j1");
      await broker.claim("test-q", "worker-1", 1, 30000);

      await expect(broker.extendLock("j1", "worker-1", 60000)).resolves.not.toThrow();
    });

    it("should throw if lock stolen", async () => {
      await broker.publish("test-q", "j1");
      await broker.claim("test-q", "worker-1", 1, 30000);

      await expect(broker.extendLock("j1", "worker-2", 60000)).rejects.toThrow();
    });
  });
});
