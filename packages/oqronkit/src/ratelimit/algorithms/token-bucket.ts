import type { IStorageEngine } from "../../engine/types/engine.js";
import type { AlgorithmResult, IRateLimitAlgorithm } from "../types.js";

/**
 * Token Bucket Rate Limit Algorithm
 *
 * Stores a bucket with a token count and last refill timestamp.
 * Tokens are lazily refilled on each check based on elapsed time.
 *
 * This is the burst-friendly algorithm — if the bucket has been idle,
 * it accumulates tokens up to `max`, allowing immediate burst capacity.
 * Ideal for third-party API throttling (Stripe, SendGrid, OpenAI).
 *
 * The `windowMs` parameter is used as the refill interval when no
 * explicit `refillIntervalMs` is provided to the engine config.
 */

interface BucketState {
  tokens: number;
  lastRefillAt: number;
}

const NAMESPACE = "ratelimit:bucket";

export class TokenBucketAlgorithm implements IRateLimitAlgorithm {
  constructor(
    private readonly refillRate: number = 1,
    private readonly refillIntervalMs: number = 1_000,
  ) {}

  async consume(
    storage: IStorageEngine,
    storageKey: string,
    max: number,
    _windowMs: number,
    cost: number,
  ): Promise<AlgorithmResult> {
    const now = Date.now();

    // Load or initialize
    let bucket = await storage.get<BucketState>(NAMESPACE, storageKey);
    if (!bucket) {
      bucket = { tokens: max, lastRefillAt: now };
    }

    // Lazy refill
    const elapsed = now - bucket.lastRefillAt;
    const refillCount =
      Math.floor(elapsed / this.refillIntervalMs) * this.refillRate;
    bucket.tokens = Math.min(max, bucket.tokens + refillCount);

    // Update refill timestamp only by the consumed intervals (not raw now)
    // to prevent drift accumulation
    if (refillCount > 0) {
      const intervalsConsumed = Math.floor(elapsed / this.refillIntervalMs);
      bucket.lastRefillAt += intervalsConsumed * this.refillIntervalMs;
    }

    // Check capacity
    if (bucket.tokens < cost) {
      // Calculate how long until enough tokens are available
      const deficit = cost - bucket.tokens;
      const intervalsNeeded = Math.ceil(deficit / this.refillRate);
      const resetMs = intervalsNeeded * this.refillIntervalMs;

      // Don't persist — we didn't modify anything meaningful
      return {
        allowed: false,
        current: max - bucket.tokens,
        resetMs,
      };
    }

    // Consume tokens
    bucket.tokens -= cost;

    // Reset time = time until fully replenished
    const deficit = max - bucket.tokens;
    const intervalsNeeded = Math.ceil(deficit / this.refillRate);
    const resetMs = intervalsNeeded * this.refillIntervalMs;

    await storage.save(NAMESPACE, storageKey, {
      ...bucket,
      createdAt: now + resetMs,
    });

    return {
      allowed: true,
      current: max - bucket.tokens,
      resetMs,
    };
  }

  async peek(
    storage: IStorageEngine,
    storageKey: string,
    max: number,
    _windowMs: number,
  ): Promise<{ current: number; resetMs: number }> {
    const now = Date.now();

    const bucket = await storage.get<BucketState>(NAMESPACE, storageKey);
    if (!bucket) {
      return { current: 0, resetMs: 0 };
    }

    // Simulate lazy refill without writing
    const elapsed = now - bucket.lastRefillAt;
    const refillCount =
      Math.floor(elapsed / this.refillIntervalMs) * this.refillRate;
    const tokens = Math.min(max, bucket.tokens + refillCount);
    const used = max - tokens;

    const deficit = max - tokens;
    const intervalsNeeded = Math.ceil(deficit / this.refillRate);
    const resetMs = deficit > 0 ? intervalsNeeded * this.refillIntervalMs : 0;

    return { current: used, resetMs };
  }
}
