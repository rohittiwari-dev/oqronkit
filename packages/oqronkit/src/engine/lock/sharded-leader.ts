import { createHash } from "node:crypto";
import type { Logger } from "../logger/index.js";
import type { ILockAdapter } from "../types/engine.js";
import { LeaderElection } from "./leader-election.js";

/**
 * ShardedLeaderElection — distributes leadership across multiple shards
 * for geo-distributed scheduling.
 *
 * Each shard has an independent leader election. A node can be eligible for
 * multiple shards but only leads the ones it successfully acquires.
 *
 * Job names are hashed to shard indices so each shard handles a deterministic
 * subset of schedules.
 *
 * @example
 * ```ts
 * // Region A node — claims shards 0-3
 * const leader = new ShardedLeaderElection(lock, logger, "cron", nodeId, 8, [0,1,2,3], 30_000);
 *
 * // Region B node — claims shards 4-7
 * const leader = new ShardedLeaderElection(lock, logger, "cron", nodeId, 8, [4,5,6,7], 30_000);
 * ```
 */
export class ShardedLeaderElection {
  private shardLeaders: Map<number, LeaderElection> = new Map();

  constructor(
    private readonly lock: ILockAdapter,
    private readonly logger: Logger,
    private readonly baseKey: string,
    private readonly nodeId: string,
    private readonly totalShards: number,
    private readonly ownedShards: number[],
    private readonly ttlMs: number = 30_000,
  ) {}

  /**
   * Start leader election campaigns for each owned shard.
   */
  async start(): Promise<void> {
    for (const shardId of this.ownedShards) {
      if (shardId < 0 || shardId >= this.totalShards) {
        this.logger.warn(
          `Shard ${shardId} is out of range [0, ${this.totalShards - 1}], skipping`,
        );
        continue;
      }

      const key = `${this.baseKey}:shard:${shardId}`;
      const election = new LeaderElection(
        this.lock,
        this.logger,
        key,
        this.nodeId,
        this.ttlMs,
      );
      await election.start();
      this.shardLeaders.set(shardId, election);
    }

    this.logger.info("ShardedLeaderElection started", {
      totalShards: this.totalShards,
      ownedShards: this.ownedShards,
      nodeId: this.nodeId,
    });
  }

  /**
   * Returns the shard IDs this node currently leads.
   */
  get leadingShards(): number[] {
    const leading: number[] = [];
    for (const [shardId, election] of this.shardLeaders) {
      if (election.isLeader) {
        leading.push(shardId);
      }
    }
    return leading;
  }

  /**
   * Check if this node is the leader for at least one shard.
   */
  get isLeader(): boolean {
    for (const election of this.shardLeaders.values()) {
      if (election.isLeader) return true;
    }
    return false;
  }

  /**
   * Hash a job name to a shard index and check if this node leads that shard.
   */
  ownsJob(jobName: string): boolean {
    const shardId = ShardedLeaderElection.hashToShard(
      jobName,
      this.totalShards,
    );
    const election = this.shardLeaders.get(shardId);
    return election?.isLeader ?? false;
  }

  /**
   * Deterministically hash a string to a shard index.
   */
  static hashToShard(name: string, totalShards: number): number {
    const hash = createHash("md5").update(name).digest();
    // Use first 4 bytes as a 32-bit unsigned integer
    const num = hash.readUInt32BE(0);
    return num % totalShards;
  }

  async stop(): Promise<void> {
    for (const election of this.shardLeaders.values()) {
      await election.stop();
    }
    this.shardLeaders.clear();
  }
}
