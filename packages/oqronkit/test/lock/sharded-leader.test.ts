import { describe, expect, it, beforeEach, vi } from "vitest";
import { ShardedLeaderElection } from "../../src/engine/lock/sharded-leader.js";

// ── Mock lock adapter ────────────────────────────────────────────────────────

function createMockLock() {
  const locks = new Map<string, { ownerId: string; expiresAt: number }>();

  return {
    acquire: vi.fn(async (key: string, ownerId: string, ttl: number) => {
      const existing = locks.get(key);
      if (existing && existing.expiresAt > Date.now()) {
        // Someone else holds it
        return existing.ownerId === ownerId;
      }
      locks.set(key, { ownerId, expiresAt: Date.now() + ttl });
      return true;
    }),
    release: vi.fn(async (key: string, ownerId: string) => {
      const existing = locks.get(key);
      if (existing?.ownerId === ownerId) {
        locks.delete(key);
      }
    }),
    renew: vi.fn(async (key: string, ownerId: string, ttl: number) => {
      const existing = locks.get(key);
      if (existing?.ownerId === ownerId) {
        existing.expiresAt = Date.now() + ttl;
        return true;
      }
      return false;
    }),
    isHeld: vi.fn(async (key: string, ownerId: string) => {
      const existing = locks.get(key);
      return !!existing && existing.ownerId === ownerId && existing.expiresAt > Date.now();
    }),
    _locks: locks,
  };
}

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: "info" as const,
  };
}

describe("ShardedLeaderElection", () => {
  let lock: ReturnType<typeof createMockLock>;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    lock = createMockLock();
    logger = createMockLogger();
  });

  it("starts and becomes leader for owned shards", async () => {
    const sharded = new ShardedLeaderElection(
      lock as any,
      logger as any,
      "test:leader",
      "node-1",
      4,
      [0, 1],
      5_000,
    );

    await sharded.start();

    expect(sharded.isLeader).toBe(true);
    expect(sharded.leadingShards.length).toBeGreaterThanOrEqual(1);

    await sharded.stop();
  });

  it("skips out-of-range shards", async () => {
    const sharded = new ShardedLeaderElection(
      lock as any,
      logger as any,
      "test:leader",
      "node-1",
      4,
      [0, 99], // 99 is out of range for totalShards=4
      5_000,
    );

    await sharded.start();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("out of range"),
    );

    await sharded.stop();
  });

  it("deterministically hashes job names to shards", () => {
    // Same name always maps to the same shard with the same totalShards
    const shard1 = ShardedLeaderElection.hashToShard("my-schedule", 8);
    const shard2 = ShardedLeaderElection.hashToShard("my-schedule", 8);
    expect(shard1).toBe(shard2);

    // Different names may map to different shards
    const shardA = ShardedLeaderElection.hashToShard("schedule-a", 8);
    const shardB = ShardedLeaderElection.hashToShard("schedule-b", 8);
    expect(typeof shardA).toBe("number");
    expect(typeof shardB).toBe("number");
    expect(shardA).toBeGreaterThanOrEqual(0);
    expect(shardA).toBeLessThan(8);
    expect(shardB).toBeGreaterThanOrEqual(0);
    expect(shardB).toBeLessThan(8);
  });

  it("ownsJob returns true for jobs hashing to a led shard", async () => {
    const sharded = new ShardedLeaderElection(
      lock as any,
      logger as any,
      "test:leader",
      "node-1",
      4,
      [0, 1, 2, 3], // Owns all shards
      5_000,
    );

    await sharded.start();

    // With all shards owned, every job should be owned
    expect(sharded.ownsJob("any-job-name")).toBe(true);
    expect(sharded.ownsJob("another-one")).toBe(true);

    await sharded.stop();
  });

  it("ownsJob returns false for jobs hashing to an unowned shard", async () => {
    // This node only owns shard 0
    const sharded = new ShardedLeaderElection(
      lock as any,
      logger as any,
      "test:leader",
      "node-1",
      1024, // Many shards to make collision unlikely
      [0],
      5_000,
    );

    await sharded.start();

    // Find a job that hashes to a shard != 0
    let foundUnowned = false;
    for (let i = 0; i < 100; i++) {
      if (!sharded.ownsJob(`job-${i}`)) {
        foundUnowned = true;
        break;
      }
    }
    expect(foundUnowned).toBe(true);

    await sharded.stop();
  });

  it("isLeader is false when no shards are led", async () => {
    const sharded = new ShardedLeaderElection(
      lock as any,
      logger as any,
      "test:leader",
      "node-1",
      4,
      [], // No shards
      5_000,
    );

    await sharded.start();
    expect(sharded.isLeader).toBe(false);
    expect(sharded.leadingShards).toHaveLength(0);

    await sharded.stop();
  });

  it("creates independent locks per shard", async () => {
    const sharded = new ShardedLeaderElection(
      lock as any,
      logger as any,
      "test:leader",
      "node-1",
      4,
      [0, 2],
      5_000,
    );

    await sharded.start();

    // Should have acquired locks for shard 0 and shard 2
    expect(lock.acquire).toHaveBeenCalledWith(
      "test:leader:shard:0",
      "node-1",
      5_000,
    );
    expect(lock.acquire).toHaveBeenCalledWith(
      "test:leader:shard:2",
      "node-1",
      5_000,
    );

    await sharded.stop();
  });
});
