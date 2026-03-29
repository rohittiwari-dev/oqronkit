import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MemoryLock } from "../../src/engine/memory/memory-lock.js";
import { HeartbeatWorker } from "../../src/engine/lock/heartbeat-worker.js";
import { StallDetector } from "../../src/engine/lock/stall-detector.js";
import { LeaderElection } from "../../src/engine/lock/leader-election.js";
import type { ILockAdapter } from "../../src/engine/types/engine.js";

// ── Shared test logger ────────────────────────────────────────────────────────
const noop = () => {};
const testLogger: any = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
};

// ===========================================================================
// 1. MemoryLock Contract Tests
// ===========================================================================
describe("MemoryLock — ILockAdapter Contract", () => {
  let lock: MemoryLock;

  beforeEach(() => {
    lock = new MemoryLock();
  });

  it("acquires a lock when none exists", async () => {
    const ok = await lock.acquire("key1", "owner-A", 10_000);
    expect(ok).toBe(true);
  });

  it("rejects a second owner on same key", async () => {
    await lock.acquire("key1", "owner-A", 10_000);
    const ok = await lock.acquire("key1", "owner-B", 10_000);
    expect(ok).toBe(false);
  });

  it("allows the same owner to re-acquire (idempotent refresh)", async () => {
    await lock.acquire("key1", "owner-A", 10_000);
    const ok = await lock.acquire("key1", "owner-A", 10_000);
    expect(ok).toBe(true);
  });

  it("allows acquisition after lock expires", async () => {
    await lock.acquire("key1", "owner-A", 1); // 1ms TTL
    await new Promise((r) => setTimeout(r, 5));
    const ok = await lock.acquire("key1", "owner-B", 10_000);
    expect(ok).toBe(true);
  });

  it("renews a held lock", async () => {
    await lock.acquire("key1", "owner-A", 10_000);
    const ok = await lock.renew("key1", "owner-A", 10_000);
    expect(ok).toBe(true);
  });

  it("rejects renewal by a non-owner", async () => {
    await lock.acquire("key1", "owner-A", 10_000);
    const ok = await lock.renew("key1", "owner-B", 10_000);
    expect(ok).toBe(false);
  });

  it("rejects renewal on an expired lock", async () => {
    await lock.acquire("key1", "owner-A", 1);
    await new Promise((r) => setTimeout(r, 5));
    const ok = await lock.renew("key1", "owner-A", 10_000);
    expect(ok).toBe(false);
  });

  it("releases a lock for the correct owner", async () => {
    await lock.acquire("key1", "owner-A", 10_000);
    await lock.release("key1", "owner-A");
    const ok = await lock.acquire("key1", "owner-B", 10_000);
    expect(ok).toBe(true);
  });

  it("does not release if caller is not the owner", async () => {
    await lock.acquire("key1", "owner-A", 10_000);
    await lock.release("key1", "owner-B"); // Should be a no-op
    const ok = await lock.acquire("key1", "owner-B", 10_000);
    expect(ok).toBe(false); // A still holds it
  });

  it("isOwner returns true for current owner", async () => {
    await lock.acquire("key1", "owner-A", 10_000);
    expect(await lock.isOwner("key1", "owner-A")).toBe(true);
    expect(await lock.isOwner("key1", "owner-B")).toBe(false);
  });

  it("isOwner returns false after expiry", async () => {
    await lock.acquire("key1", "owner-A", 1);
    await new Promise((r) => setTimeout(r, 5));
    expect(await lock.isOwner("key1", "owner-A")).toBe(false);
  });

  it("isOwner returns false for non-existent key", async () => {
    expect(await lock.isOwner("no-key", "owner-A")).toBe(false);
  });
});

// ===========================================================================
// 2. HeartbeatWorker Tests
// ===========================================================================
describe("HeartbeatWorker", () => {
  let lock: MemoryLock;

  beforeEach(() => {
    lock = new MemoryLock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("acquires the lock and becomes active on start()", async () => {
    const hb = new HeartbeatWorker(lock, testLogger, "hb:1", "w-1", 5000, 500);
    const ok = await hb.start();
    expect(ok).toBe(true);
    expect(hb.isActive).toBe(true);
    await hb.stop();
  });

  it("fails to start if lock is already held by someone else", async () => {
    await lock.acquire("hb:1", "other-owner", 30_000);
    const hb = new HeartbeatWorker(lock, testLogger, "hb:1", "w-1", 5000, 500);
    const ok = await hb.start();
    expect(ok).toBe(false);
    expect(hb.isActive).toBe(false);
  });

  it("releases the lock on stop()", async () => {
    const hb = new HeartbeatWorker(lock, testLogger, "hb:2", "w-1", 5000, 500);
    await hb.start();
    await hb.stop();
    expect(hb.isActive).toBe(false);

    // Lock should now be free
    const ok = await lock.acquire("hb:2", "w-2", 5000);
    expect(ok).toBe(true);
  });

  it("renews the lock periodically while active", async () => {
    const renewSpy = vi.spyOn(lock, "renew");
    const hb = new HeartbeatWorker(lock, testLogger, "hb:3", "w-1", 2000, 50);
    await hb.start();

    // Wait long enough for at least 1 renewal
    await new Promise((r) => setTimeout(r, 120));
    expect(renewSpy).toHaveBeenCalledWith("hb:3", "w-1", 2000);
    expect(renewSpy.mock.calls.length).toBeGreaterThanOrEqual(1);

    await hb.stop();
  });
});

// ===========================================================================
// 3. StallDetector Tests
// ===========================================================================
describe("StallDetector", () => {
  let lock: MemoryLock;

  beforeEach(() => {
    lock = new MemoryLock();
  });

  it("detects a stalled job when lock is lost", async () => {
    // First, acquire and then release (simulating crash — lock expired)
    const stalledKeys: string[] = [];

    const detector = new StallDetector(lock, testLogger, 30); // 30ms interval
    detector.start(
      () => [{ key: "job:123", ownerId: "w-dead" }], // No lock held
      (key) => stalledKeys.push(key),
    );

    await new Promise((r) => setTimeout(r, 80)); // Wait for at least 1 tick
    detector.stop();

    expect(stalledKeys).toContain("job:123");
  });

  it("does NOT fire for owned jobs", async () => {
    await lock.acquire("job:alive", "w-1", 60_000);
    const stalledKeys: string[] = [];

    const detector = new StallDetector(lock, testLogger, 30);
    detector.start(
      () => [{ key: "job:alive", ownerId: "w-1" }],
      (key) => stalledKeys.push(key),
    );

    await new Promise((r) => setTimeout(r, 80));
    detector.stop();

    expect(stalledKeys).toHaveLength(0);
  });

  it("stops cleanly and does not fire after stop()", async () => {
    const stalledKeys: string[] = [];
    const detector = new StallDetector(lock, testLogger, 20);
    detector.start(
      () => [{ key: "k1", ownerId: "dead" }],
      (key) => stalledKeys.push(key),
    );

    detector.stop();
    const countAtStop = stalledKeys.length;

    await new Promise((r) => setTimeout(r, 60));
    expect(stalledKeys.length).toBe(countAtStop); // No new fires after stop
  });
});

// ===========================================================================
// 4. LeaderElection Tests
// ===========================================================================
describe("LeaderElection", () => {
  let lock: MemoryLock;

  beforeEach(() => {
    lock = new MemoryLock();
  });

  it("becomes leader when no one else holds the key", async () => {
    const election = new LeaderElection(
      lock,
      testLogger,
      "leader:test",
      "node-1",
      5000,
    );
    await election.start();

    // campaign() runs synchronously in start()
    expect(election.isLeader).toBe(true);
    await election.stop();
  });

  it("does NOT become leader when key is already held", async () => {
    await lock.acquire("leader:test", "node-existing", 30_000);

    const election = new LeaderElection(
      lock,
      testLogger,
      "leader:test",
      "node-2",
      5000,
    );
    await election.start();

    expect(election.isLeader).toBe(false);
    await election.stop();
  });

  it("releases the lock on stop() when it is leader", async () => {
    const election = new LeaderElection(
      lock,
      testLogger,
      "leader:test",
      "node-1",
      5000,
    );
    await election.start();
    expect(election.isLeader).toBe(true);

    await election.stop();
    expect(election.isLeader).toBe(false);

    // Lock should be free now
    const ok = await lock.acquire("leader:test", "node-2", 5000);
    expect(ok).toBe(true);
  });

  it("two nodes competing — only one becomes leader", async () => {
    const e1 = new LeaderElection(
      lock,
      testLogger,
      "leader:race",
      "node-1",
      5000,
    );
    const e2 = new LeaderElection(
      lock,
      testLogger,
      "leader:race",
      "node-2",
      5000,
    );

    await e1.start();
    await e2.start();

    // Exactly one should be leader
    const leaders = [e1.isLeader, e2.isLeader].filter(Boolean);
    expect(leaders.length).toBe(1);

    await e1.stop();
    await e2.stop();
  });

  it("takes over leadership after the previous leader's lock expires", async () => {
    // node-1 acquires with a very short TTL
    await lock.acquire("leader:expire", "node-1", 1); // 1ms TTL
    await new Promise((r) => setTimeout(r, 10)); // Wait for expiry

    const e2 = new LeaderElection(
      lock,
      testLogger,
      "leader:expire",
      "node-2",
      5000,
    );
    await e2.start();
    expect(e2.isLeader).toBe(true);
    await e2.stop();
  });
});
