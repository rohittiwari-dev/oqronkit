import { describe, expect, it, beforeEach } from "vitest";
import { MemoryAdapter } from "../../src/adapters/memory.adapter.js";

describe("MemoryBrokerAdapter", () => {
  let adapter: MemoryAdapter;

  beforeEach(() => {
    adapter = new MemoryAdapter();
  });

  describe("signaling and claiming", () => {
    it("should signal enqueue and allow a worker to claim IDs", async () => {
      await adapter.signalEnqueue("test-q", "job-123");

      const claimed = await adapter.claimJobIds("test-q", "worker-1", 1, 30000);
      expect(claimed.length).toBe(1);
      expect(claimed[0]).toBe("job-123");
    });

    it("should respect limits", async () => {
      await adapter.signalEnqueue("test-q", "j1");
      await adapter.signalEnqueue("test-q", "j2");

      const claimed = await adapter.claimJobIds("test-q", "worker-1", 1, 30000);
      expect(claimed.length).toBe(1);
    });
  });

  describe("locks and acks", () => {
    it("should allow extending locks", async () => {
      await adapter.signalEnqueue("test-q", "j1");
      await adapter.claimJobIds("test-q", "worker-1", 1, 30000);

      await expect(adapter.extendLock("j1", "worker-1", 60000)).resolves.not.toThrow();
    });

    it("should throw if lock stolen", async () => {
      await adapter.signalEnqueue("test-q", "j1");
      await adapter.claimJobIds("test-q", "worker-1", 1, 30000);

      await expect(adapter.extendLock("j1", "worker-2", 60000)).rejects.toThrow();
    });
  });
});
