/**
 * Per-process sliding-window throttle gate.
 *
 * Tracks the number of dispatches in a rolling time window and reports
 * how many more are allowed. Used by Queue, Worker, and Webhook engines
 * to cap dispatch rate independently of concurrency (parallel limit).
 *
 * This is intentionally in-memory and per-process:
 * - Each worker node independently caps its own dispatch rate.
 * - For distributed cluster-wide rate limiting, compose with `rateLimiter`.
 */
export interface ThrottleConfig {
  /** Maximum dispatches allowed per window. */
  max: number;
  /** Window duration in milliseconds. */
  duration: number;
}

export class ThrottleGate {
  /** Sorted array of dispatch timestamps within the current window. */
  private timestamps: number[] = [];

  constructor(private readonly config: ThrottleConfig) {
    if (config.max <= 0) {
      throw new Error("ThrottleConfig.max must be a positive integer");
    }
    if (config.duration <= 0) {
      throw new Error("ThrottleConfig.duration must be a positive integer");
    }
  }

  /**
   * Returns how many more dispatches are allowed in the current window.
   * Prunes expired timestamps on every call.
   */
  getAvailable(): number {
    this.prune();
    return Math.max(0, this.config.max - this.timestamps.length);
  }

  /**
   * Record `count` dispatches at the current time.
   * Call this after successfully claiming jobs from the broker.
   */
  record(count: number): void {
    const now = Date.now();
    for (let i = 0; i < count; i++) {
      this.timestamps.push(now);
    }
  }

  /** Remove timestamps that have fallen outside the window. */
  private prune(): void {
    const cutoff = Date.now() - this.config.duration;
    // Binary search would be faster for large arrays, but dispatch counts
    // per window are small (typically < 1000) so filter is fine.
    this.timestamps = this.timestamps.filter((t) => t > cutoff);
  }
}
