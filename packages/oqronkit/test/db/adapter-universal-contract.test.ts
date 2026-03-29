import { describe, it, expect, beforeEach } from "vitest";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";
import { MemoryStore } from "../../src/engine/memory/memory-store.js";
import { MemoryLock } from "../../src/engine/memory/memory-lock.js";
import type {
  IBrokerEngine,
  ILockAdapter,
  IStorageEngine,
} from "../../src/engine/types/engine.js";

/**
 * Universal Adapter Contract Suite.
 *
 * Any IStorageEngine / IBrokerEngine / ILockAdapter implementation MUST pass
 * these. When Redis or PostgreSQL integration tests are wired up, just call
 * these same helpers with the real adapter instance.
 */

// ===========================================================================
// IStorageEngine Universal Contract
// ===========================================================================
function runStorageContract(
  label: string,
  createStore: () => IStorageEngine,
) {
  describe(`${label} — IStorageEngine Contract`, () => {
    let store: IStorageEngine;

    beforeEach(() => {
      store = createStore();
    });

    it("save + get round-trip", async () => {
      await store.save("ns", "id1", { hello: "world" });
      const val = await store.get<{ hello: string }>("ns", "id1");
      expect(val?.hello).toBe("world");
    });

    it("get returns null for missing key", async () => {
      expect(await store.get("ns", "missing")).toBeNull();
    });

    it("save overwrites existing value", async () => {
      await store.save("ns", "id1", { v: 1 });
      await store.save("ns", "id1", { v: 2 });
      const val = await store.get<{ v: number }>("ns", "id1");
      expect(val?.v).toBe(2);
    });

    it("list returns all items in namespace", async () => {
      await store.save("ns", "a", { id: "a" });
      await store.save("ns", "b", { id: "b" });
      const items = await store.list("ns");
      expect(items).toHaveLength(2);
    });

    it("list with filter returns matching items only", async () => {
      await store.save("ns", "a", { status: "active" });
      await store.save("ns", "b", { status: "paused" });
      await store.save("ns", "c", { status: "active" });
      const active = await store.list("ns", { status: "active" });
      expect(active).toHaveLength(2);
    });

    it("list with limit returns at most N items", async () => {
      for (let i = 0; i < 10; i++) {
        await store.save("ns", `item-${i}`, { i });
      }
      const page = await store.list("ns", undefined, { limit: 3 });
      expect(page).toHaveLength(3);
    });

    it("list with offset skips items", async () => {
      for (let i = 0; i < 5; i++) {
        await store.save("ns", `item-${i}`, { i });
      }
      const page = await store.list("ns", undefined, { limit: 5, offset: 3 });
      expect(page).toHaveLength(2);
    });

    it("count returns total", async () => {
      await store.save("ns", "x", { x: 1 });
      await store.save("ns", "y", { y: 2 });
      expect(await store.count("ns")).toBe(2);
    });

    it("count with filter returns filtered total", async () => {
      await store.save("ns", "a", { status: "done" });
      await store.save("ns", "b", { status: "done" });
      await store.save("ns", "c", { status: "pending" });
      expect(await store.count("ns", { status: "done" })).toBe(2);
    });

    it("count returns 0 for empty namespace", async () => {
      expect(await store.count("empty")).toBe(0);
    });

    it("delete removes an item", async () => {
      await store.save("ns", "del", { x: 1 });
      await store.delete("ns", "del");
      expect(await store.get("ns", "del")).toBeNull();
    });

    it("delete is idempotent for missing key", async () => {
      // Must not throw
      await expect(store.delete("ns", "ghost")).resolves.toBeUndefined();
    });

    it("prune removes old data and returns count", async () => {
      await store.save("ns", "old", {
        id: "old",
        createdAt: new Date(Date.now() - 200_000),
      });
      await store.save("ns", "new", {
        id: "new",
        createdAt: new Date(),
      });
      const pruned = await store.prune("ns", Date.now() - 100_000);
      expect(pruned).toBe(1);
      expect(await store.get("ns", "old")).toBeNull();
      expect(await store.get("ns", "new")).toBeTruthy();
    });

    it("namespaces are isolated", async () => {
      await store.save("ns-a", "id1", { a: 1 });
      await store.save("ns-b", "id1", { b: 2 });
      const a = await store.get<{ a: number }>("ns-a", "id1");
      const b = await store.get<{ b: number }>("ns-b", "id1");
      expect(a?.a).toBe(1);
      expect(b?.b).toBe(2);
    });
  });
}

// ===========================================================================
// IBrokerEngine Universal Contract
// ===========================================================================
function runBrokerContract(
  label: string,
  createBroker: () => IBrokerEngine,
) {
  describe(`${label} — IBrokerEngine Contract`, () => {
    let broker: IBrokerEngine;

    beforeEach(() => {
      broker = createBroker();
    });

    it("publish + claim round-trip (FIFO)", async () => {
      await broker.publish("q", "j1");
      await broker.publish("q", "j2");
      const ids = await broker.claim("q", "w1", 2, 30000, "fifo");
      expect(ids).toEqual(["j1", "j2"]);
    });

    it("claim returns empty when queue is empty", async () => {
      const ids = await broker.claim("q", "w1", 5, 30000);
      expect(ids).toEqual([]);
    });

    it("claim respects limit", async () => {
      await broker.publish("q", "a");
      await broker.publish("q", "b");
      await broker.publish("q", "c");
      const ids = await broker.claim("q", "w1", 2, 30000);
      expect(ids).toHaveLength(2);
    });

    it("ack removes item from further claims", async () => {
      await broker.publish("q", "j1");
      const ids = await broker.claim("q", "w1", 1, 30000);
      await broker.ack("q", ids[0]);
      // Should not be claimable again
      const ids2 = await broker.claim("q", "w2", 1, 30000);
      expect(ids2).toEqual([]);
    });

    it("nack re-queues for immediate retry", async () => {
      await broker.publish("q", "j1");
      await broker.claim("q", "w1", 1, 30000);
      await broker.nack("q", "j1");

      // Should be claimable again
      const ids = await broker.claim("q", "w2", 1, 30000);
      expect(ids).toContain("j1");
    });

    it("nack with delay schedules for future", async () => {
      await broker.publish("q", "j1");
      await broker.claim("q", "w1", 1, 30000);
      await broker.nack("q", "j1", 60_000); // 60s delay

      // Should NOT be immediately claimable (it's delayed)
      const ids = await broker.claim("q", "w2", 1, 30000);
      expect(ids).not.toContain("j1");
    });

    it("delayed publish is not immediately claimable", async () => {
      await broker.publish("q", "delayed-1", 60_000);
      const ids = await broker.claim("q", "w1", 1, 30000);
      expect(ids).toEqual([]);
    });

    it("pause prevents claims, resume restores them", async () => {
      await broker.publish("q", "j1");
      await broker.pause("q");
      const ids = await broker.claim("q", "w1", 1, 30000);
      expect(ids).toEqual([]);

      await broker.resume("q");
      const ids2 = await broker.claim("q", "w2", 1, 30000);
      expect(ids2).toContain("j1");
    });

    it("extendLock succeeds for owned item", async () => {
      await broker.publish("q", "j1");
      await broker.claim("q", "w1", 1, 30000);
      // Should not throw
      await expect(
        broker.extendLock("j1", "w1", 30000),
      ).resolves.toBeUndefined();
    });

    it("extendLock throws for stolen lock", async () => {
      // Item not locked by this consumer
      await expect(
        broker.extendLock("not-locked", "w1", 30000),
      ).rejects.toThrow();
    });

    it("queues are isolated by name", async () => {
      await broker.publish("q-a", "item1");
      await broker.publish("q-b", "item2");

      const fromA = await broker.claim("q-a", "w1", 1, 30000);
      const fromB = await broker.claim("q-b", "w1", 1, 30000);

      expect(fromA).toEqual(["item1"]);
      expect(fromB).toEqual(["item2"]);
    });
  });
}

// ===========================================================================
// ILockAdapter Universal Contract
// ===========================================================================
function runLockContract(
  label: string,
  createLock: () => ILockAdapter,
) {
  describe(`${label} — ILockAdapter Contract`, () => {
    let lock: ILockAdapter;

    beforeEach(() => {
      lock = createLock();
    });

    it("acquire succeeds on fresh key", async () => {
      expect(await lock.acquire("k", "o1", 10000)).toBe(true);
    });

    it("acquire fails for competing owner", async () => {
      await lock.acquire("k", "o1", 10000);
      expect(await lock.acquire("k", "o2", 10000)).toBe(false);
    });

    it("same owner can re-acquire", async () => {
      await lock.acquire("k", "o1", 10000);
      expect(await lock.acquire("k", "o1", 10000)).toBe(true);
    });

    it("renew succeeds for owner", async () => {
      await lock.acquire("k", "o1", 10000);
      expect(await lock.renew("k", "o1", 10000)).toBe(true);
    });

    it("renew fails for non-owner", async () => {
      await lock.acquire("k", "o1", 10000);
      expect(await lock.renew("k", "o2", 10000)).toBe(false);
    });

    it("release frees the key for another owner", async () => {
      await lock.acquire("k", "o1", 10000);
      await lock.release("k", "o1");
      expect(await lock.acquire("k", "o2", 10000)).toBe(true);
    });

    it("release by wrong owner does nothing", async () => {
      await lock.acquire("k", "o1", 10000);
      await lock.release("k", "o2");
      expect(await lock.acquire("k", "o2", 10000)).toBe(false);
    });

    it("isOwner returns true for active owner", async () => {
      await lock.acquire("k", "o1", 10000);
      expect(await lock.isOwner("k", "o1")).toBe(true);
    });

    it("isOwner returns false for different owner", async () => {
      await lock.acquire("k", "o1", 10000);
      expect(await lock.isOwner("k", "o2")).toBe(false);
    });

    it("expired lock allows new acquisition", async () => {
      await lock.acquire("k", "o1", 1);
      await new Promise((r) => setTimeout(r, 10));
      expect(await lock.acquire("k", "o2", 10000)).toBe(true);
    });
  });
}

// ===========================================================================
// Run all contracts against Memory adapters
// ===========================================================================
runStorageContract("MemoryStore", () => new MemoryStore());
runBrokerContract("MemoryBroker", () => new MemoryBroker());
runLockContract("MemoryLock", () => new MemoryLock());

// NOTE: To run against Redis, add the following blocks (requires local Redis):
//
// import Redis from "ioredis";
// import { RedisStore } from "../../src/engine/redis/redis-store.js";
// import { RedisBroker } from "../../src/engine/redis/redis-broker.js";
// import { RedisLock } from "../../src/engine/redis/redis-lock.js";
//
// const redis = new Redis("redis://localhost:6379");
// runStorageContract("RedisStore", () => new RedisStore(redis, "test"));
// runBrokerContract("RedisBroker", () => new RedisBroker(redis, "test"));
// runLockContract("RedisLock", () => new RedisLock(redis, "test"));
