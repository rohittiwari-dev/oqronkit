import type { IStorageEngine } from "../engine/types/engine.js";
import type { ILockAdapter } from "../engine/types/engine.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerConfig {
  /** Consecutive failures before OPEN. @default 5 */
  failureThreshold?: number;
  /** Time in OPEN before transitioning to HALF_OPEN (ms). @default 30000 */
  resetTimeoutMs?: number;
  /** Probes allowed in HALF_OPEN before deciding. @default 1 */
  halfOpenMaxAttempts?: number;
  /** Sliding window for failure counting (ms). @default 60000 */
  windowMs?: number;
}

export interface ICircuitBreaker {
  recordSuccess(endpointKey: string): Promise<void>;
  recordFailure(endpointKey: string): Promise<void>;
  isOpen(endpointKey: string): Promise<boolean>;
  getState(endpointKey: string): Promise<CircuitState>;
  reset(endpointKey: string): Promise<void>;
}

interface CircuitEntry {
  state: CircuitState;
  failures: number;
  lastFailureAt: number;
  halfOpenAttempts: number;
}

// ── In-Memory Implementation ─────────────────────────────────────────────────

export class MemoryCircuitBreaker implements ICircuitBreaker {
  private circuits = new Map<string, CircuitEntry>();

  constructor(private config: CircuitBreakerConfig = {}) {}

  private get threshold() { return this.config.failureThreshold ?? 5; }
  private get resetMs() { return this.config.resetTimeoutMs ?? 30000; }
  private get halfOpenMax() { return this.config.halfOpenMaxAttempts ?? 1; }

  private getEntry(key: string): CircuitEntry {
    let entry = this.circuits.get(key);
    if (!entry) {
      entry = { state: "CLOSED", failures: 0, lastFailureAt: 0, halfOpenAttempts: 0 };
      this.circuits.set(key, entry);
    }
    return entry;
  }

  async recordSuccess(key: string): Promise<void> {
    const entry = this.getEntry(key);
    entry.failures = 0;
    entry.halfOpenAttempts = 0;
    entry.state = "CLOSED";
  }

  async recordFailure(key: string): Promise<void> {
    const entry = this.getEntry(key);
    entry.failures++;
    entry.lastFailureAt = Date.now();

    if (entry.state === "HALF_OPEN") {
      // Any failure in HALF_OPEN → back to OPEN
      entry.state = "OPEN";
      entry.halfOpenAttempts = 0;
    } else if (entry.failures >= this.threshold) {
      entry.state = "OPEN";
    }
  }

  async isOpen(key: string): Promise<boolean> {
    const state = await this.getState(key);
    return state === "OPEN";
  }

  async getState(key: string): Promise<CircuitState> {
    const entry = this.getEntry(key);

    if (entry.state === "OPEN") {
      // Check if reset timeout has elapsed → transition to HALF_OPEN
      if (Date.now() - entry.lastFailureAt >= this.resetMs) {
        entry.state = "HALF_OPEN";
        entry.halfOpenAttempts = 0;
        return "HALF_OPEN";
      }
      return "OPEN";
    }

    if (entry.state === "HALF_OPEN") {
      if (entry.halfOpenAttempts >= this.halfOpenMax) {
        // Too many probes without success → back to OPEN
        entry.state = "OPEN";
        return "OPEN";
      }
      entry.halfOpenAttempts++;
      return "HALF_OPEN";
    }

    return "CLOSED";
  }

  async reset(key: string): Promise<void> {
    this.circuits.delete(key);
  }
}

// ── Shared / Distributed Implementation ──────────────────────────────────────

export class SharedCircuitBreaker implements ICircuitBreaker {
  private readonly NS = "webhook_circuit_breaker";

  constructor(
    private config: CircuitBreakerConfig = {},
    private storage: IStorageEngine,
    private lock?: ILockAdapter,
  ) {}

  private get threshold() { return this.config.failureThreshold ?? 5; }
  private get resetMs() { return this.config.resetTimeoutMs ?? 30000; }
  private get halfOpenMax() { return this.config.halfOpenMaxAttempts ?? 1; }

  private async getEntry(key: string): Promise<CircuitEntry> {
    const raw = await this.storage.get<CircuitEntry>(this.NS, key);
    return raw ?? { state: "CLOSED", failures: 0, lastFailureAt: 0, halfOpenAttempts: 0 };
  }

  private async saveEntry(key: string, entry: CircuitEntry): Promise<void> {
    await this.storage.save(this.NS, key, entry);
  }

  private async withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (!this.lock) return fn();
    const lockKey = `webhook:circuit:${key}`;
    const owner = `circuit-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const ttlMs = 5_000;
    const deadline = Date.now() + ttlMs;
    while (!(await this.lock.acquire(lockKey, owner, ttlMs))) {
      if (Date.now() >= deadline) {
        throw new Error(`[OqronKit] Timed out acquiring circuit lock for ${key}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    try {
      return await fn();
    } finally {
      await this.lock.release(lockKey, owner).catch(() => {});
    }
  }

  async recordSuccess(key: string): Promise<void> {
    await this.withKeyLock(key, async () => {
      const entry = await this.getEntry(key);
      entry.failures = 0;
      entry.halfOpenAttempts = 0;
      entry.state = "CLOSED";
      await this.saveEntry(key, entry);
    });
  }

  async recordFailure(key: string): Promise<void> {
    await this.withKeyLock(key, async () => {
      const entry = await this.getEntry(key);
      entry.failures++;
      entry.lastFailureAt = Date.now();

      if (entry.state === "HALF_OPEN") {
        entry.state = "OPEN";
        entry.halfOpenAttempts = 0;
      } else if (entry.failures >= this.threshold) {
        entry.state = "OPEN";
      }
      await this.saveEntry(key, entry);
    });
  }

  async isOpen(key: string): Promise<boolean> {
    const state = await this.getState(key);
    return state === "OPEN";
  }

  async getState(key: string): Promise<CircuitState> {
    return this.withKeyLock(key, async () => {
      const entry = await this.getEntry(key);

      if (entry.state === "OPEN") {
        if (Date.now() - entry.lastFailureAt >= this.resetMs) {
          entry.state = "HALF_OPEN";
          entry.halfOpenAttempts = 0;
          await this.saveEntry(key, entry);
          return "HALF_OPEN";
        }
        return "OPEN";
      }

      if (entry.state === "HALF_OPEN") {
        if (entry.halfOpenAttempts >= this.halfOpenMax) {
          entry.state = "OPEN";
          await this.saveEntry(key, entry);
          return "OPEN";
        }
        entry.halfOpenAttempts++;
        await this.saveEntry(key, entry);
        return "HALF_OPEN";
      }

      return "CLOSED";
    });
  }

  async reset(key: string): Promise<void> {
    await this.storage.delete(this.NS, key);
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a circuit breaker instance.
 * Defaults to in-memory. If a storage engine is provided, uses shared/distributed state.
 */
export function createCircuitBreaker(
  config: CircuitBreakerConfig = {},
  storage?: IStorageEngine,
  lock?: ILockAdapter,
): ICircuitBreaker {
  if (storage) return new SharedCircuitBreaker(config, storage, lock);
  return new MemoryCircuitBreaker(config);
}
