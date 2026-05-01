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

    it("acks only the matching broker when job ids collide across brokers", async () => {
      await broker.publish("q1", "same-id");
      await broker.publish("q2", "same-id");

      expect(await broker.claim("q1", "worker-1", 1, 30000)).toEqual(["same-id"]);
      expect(await broker.claim("q2", "worker-2", 1, 30000)).toEqual(["same-id"]);

      await broker.ack("q1", "same-id");

      await expect(
        broker.extendLock("same-id", "worker-1", 30000),
      ).rejects.toThrow();
      await expect(
        broker.extendLock("same-id", "worker-2", 30000),
      ).resolves.not.toThrow();
    });
  });
});
