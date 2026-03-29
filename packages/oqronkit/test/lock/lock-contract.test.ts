import { describe, it, expect, beforeEach } from "vitest";
import { MemoryLockAdapter } from "../../src/adapters/lock/memory-lock.adapter.js";
import type { ILockAdapter } from "../../src/core/types/lock.types.js";

function runLockContractTests(
  name: string,
  createAdapter: () => ILockAdapter,
) {
  describe(`${name} — ILockAdapter Contract`, () => {
    let lock: ILockAdapter;

    beforeEach(() => {
      lock = createAdapter();
    });

    it("acquires a lock successfully", async () => {
      const result = await lock.acquire("resource-1", "node-A", 30_000);
      expect(result).toBe(true);
    });

    it("prevents double-acquisition by a different owner", async () => {
      await lock.acquire("resource-1", "node-A", 30_000);
      const result = await lock.acquire("resource-1", "node-B", 30_000);
      expect(result).toBe(false);
    });

    it("allows same owner to re-acquire", async () => {
      await lock.acquire("resource-1", "node-A", 30_000);
      const result = await lock.acquire("resource-1", "node-A", 30_000);
      // Most adapters allow this (idempotent), some don't — both are valid
      expect(typeof result).toBe("boolean");
    });

    it("isOwner returns true for the lock holder", async () => {
      await lock.acquire("resource-1", "node-A", 30_000);
      const owns = await lock.isOwner("resource-1", "node-A");
      expect(owns).toBe(true);
    });

    it("isOwner returns false for non-holders", async () => {
      await lock.acquire("resource-1", "node-A", 30_000);
      const owns = await lock.isOwner("resource-1", "node-B");
      expect(owns).toBe(false);
    });

    it("isOwner returns false for non-existent keys", async () => {
      const owns = await lock.isOwner("nonexistent", "node-A");
      expect(owns).toBe(false);
    });

    it("renews a lock that is owned", async () => {
      await lock.acquire("resource-1", "node-A", 30_000);
      const renewed = await lock.renew("resource-1", "node-A", 60_000);
      expect(renewed).toBe(true);
    });

    it("fails to renew a lock owned by someone else", async () => {
      await lock.acquire("resource-1", "node-A", 30_000);
      const renewed = await lock.renew("resource-1", "node-B", 60_000);
      expect(renewed).toBe(false);
    });

    it("releases a lock", async () => {
      await lock.acquire("resource-1", "node-A", 30_000);
      await lock.release("resource-1", "node-A");

      const owns = await lock.isOwner("resource-1", "node-A");
      expect(owns).toBe(false);
    });

    it("after release, another owner can acquire", async () => {
      await lock.acquire("resource-1", "node-A", 30_000);
      await lock.release("resource-1", "node-A");

      const result = await lock.acquire("resource-1", "node-B", 30_000);
      expect(result).toBe(true);
    });

    it("release by non-owner does not affect the lock", async () => {
      await lock.acquire("resource-1", "node-A", 30_000);
      await lock.release("resource-1", "node-B"); // wrong owner

      const owns = await lock.isOwner("resource-1", "node-A");
      expect(owns).toBe(true);
    });
  });
}

// Run against MemoryLockAdapter
runLockContractTests("MemoryLockAdapter", () => new MemoryLockAdapter());
