import { OqronEventBus } from "../engine/index.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ScheduleMetrics {
  name: string;
  type: "cron" | "schedule";
  runs: number;
  successes: number;
  failures: number;
  stalls: number;
  rateLimited: number;
  duration: {
    min: number;
    max: number;
    avg: number;
    p95: number;
    p99: number;
    last: number;
  };
  lastRunAt?: Date;
  nextRunAt?: Date;
  lagMs?: number;
}

export interface SchedulerMetricsSnapshot {
  timestamp: Date;
  totalSchedules: number;
  totalRuns: number;
  totalSuccesses: number;
  totalFailures: number;
  schedules: ScheduleMetrics[];
}

// ── Ring Buffer for percentile calculations ──────────────────────────────────

class DurationRingBuffer {
  private readonly buffer: number[];
  private writePos = 0;
  private count = 0;

  constructor(private readonly capacity: number = 1000) {
    this.buffer = new Array(capacity).fill(0);
  }

  push(durationMs: number): void {
    this.buffer[this.writePos] = durationMs;
    this.writePos = (this.writePos + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  getStats(): {
    min: number;
    max: number;
    avg: number;
    p95: number;
    p99: number;
    last: number;
  } {
    if (this.count === 0) {
      return { min: 0, max: 0, avg: 0, p95: 0, p99: 0, last: 0 };
    }

    const values = this.buffer.slice(0, this.count);
    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);

    return {
      min: sorted[0]!,
      max: sorted[sorted.length - 1]!,
      avg: sum / sorted.length,
      p95: sorted[Math.floor(sorted.length * 0.95)]!,
      p99: sorted[Math.floor(sorted.length * 0.99)]!,
      last: this.buffer[(this.writePos - 1 + this.capacity) % this.capacity]!,
    };
  }

  reset(): void {
    this.buffer.fill(0);
    this.writePos = 0;
    this.count = 0;
  }
}

// ── Per-schedule metric accumulator ──────────────────────────────────────────

interface ScheduleAccumulator {
  name: string;
  type: "cron" | "schedule";
  runs: number;
  successes: number;
  failures: number;
  stalls: number;
  rateLimited: number;
  durations: DurationRingBuffer;
  lastRunAt?: Date;
}

// ── Main Metrics Class ───────────────────────────────────────────────────────

/**
 * SchedulerMetrics — lightweight metrics collector for cron and schedule modules.
 *
 * Subscribes to OqronEventBus events and maintains per-schedule counters and
 * duration histograms. Exposes structured snapshots via `getMetrics()` for
 * consumption by Prometheus, OpenTelemetry, or custom dashboards.
 *
 * Zero external dependencies. No background timers — all updates are event-driven.
 */
export class SchedulerMetrics {
  private readonly schedules = new Map<string, ScheduleAccumulator>();
  private listening = false;

  /**
   * Start listening to EventBus events.
   * Safe to call multiple times — only subscribes once.
   */
  start(): void {
    if (this.listening) return;
    this.listening = true;

    OqronEventBus.on("schedule:fire:start", this.handleFireStart);
    OqronEventBus.on("schedule:fire:complete", this.handleFireComplete);
    OqronEventBus.on("job:stalled", this.handleStalled);
    OqronEventBus.on("schedule:rate-limited", this.handleRateLimited);
  }

  /** Stop listening to EventBus events. */
  stop(): void {
    if (!this.listening) return;
    this.listening = false;

    OqronEventBus.off("schedule:fire:start", this.handleFireStart);
    OqronEventBus.off("schedule:fire:complete", this.handleFireComplete);
    OqronEventBus.off("job:stalled", this.handleStalled);
    OqronEventBus.off("schedule:rate-limited", this.handleRateLimited);
  }

  /** Get a full metrics snapshot for all tracked schedules. */
  getMetrics(): SchedulerMetricsSnapshot {
    let totalRuns = 0;
    let totalSuccesses = 0;
    let totalFailures = 0;
    const schedules: ScheduleMetrics[] = [];

    for (const acc of this.schedules.values()) {
      totalRuns += acc.runs;
      totalSuccesses += acc.successes;
      totalFailures += acc.failures;

      schedules.push({
        name: acc.name,
        type: acc.type,
        runs: acc.runs,
        successes: acc.successes,
        failures: acc.failures,
        stalls: acc.stalls,
        rateLimited: acc.rateLimited,
        duration: acc.durations.getStats(),
        lastRunAt: acc.lastRunAt,
      });
    }

    return {
      timestamp: new Date(),
      totalSchedules: this.schedules.size,
      totalRuns,
      totalSuccesses,
      totalFailures,
      schedules,
    };
  }

  /** Get metrics for a single schedule by name. */
  getMetricsForSchedule(name: string): ScheduleMetrics | undefined {
    const acc = this.schedules.get(name);
    if (!acc) return undefined;

    return {
      name: acc.name,
      type: acc.type,
      runs: acc.runs,
      successes: acc.successes,
      failures: acc.failures,
      stalls: acc.stalls,
      rateLimited: acc.rateLimited,
      duration: acc.durations.getStats(),
      lastRunAt: acc.lastRunAt,
    };
  }

  /** Reset all collected metrics. Useful for testing. */
  resetMetrics(): void {
    this.schedules.clear();
  }

  // ── Private: ensure accumulator exists ────────────────────────────────────

  private getOrCreate(
    name: string,
    type: "cron" | "schedule",
  ): ScheduleAccumulator {
    let acc = this.schedules.get(name);
    if (!acc) {
      acc = {
        name,
        type,
        runs: 0,
        successes: 0,
        failures: 0,
        stalls: 0,
        rateLimited: 0,
        durations: new DurationRingBuffer(),
      };
      this.schedules.set(name, acc);
    }
    return acc;
  }

  // ── Event handlers (bound arrow functions for safe unsubscribe) ───────────

  private handleFireStart = (
    scheduleName: string,
    _runId: string,
    type: "cron" | "schedule",
  ): void => {
    const acc = this.getOrCreate(scheduleName, type);
    acc.runs++;
    acc.lastRunAt = new Date();
  };

  private handleFireComplete = (
    scheduleName: string,
    _runId: string,
    status: "completed" | "failed",
    durationMs: number,
  ): void => {
    const acc = this.schedules.get(scheduleName);
    if (!acc) return;

    if (status === "completed") {
      acc.successes++;
    } else {
      acc.failures++;
    }
    acc.durations.push(durationMs);
  };

  private handleStalled = (_queueName: string, _jobId: string): void => {
    // Stalled events come from queue-level, we try to match by iterating
    // For scheduler stalls, the queueName is "system_cron" or "system_schedule"
    // We can't reliably map to a specific schedule, so we skip per-schedule
    // tracking here. The base engine emits schedule-specific stalls via the
    // enrichment path. This is a best-effort counter.
  };

  private handleRateLimited = (scheduleName: string): void => {
    const acc = this.schedules.get(scheduleName);
    if (acc) {
      acc.rateLimited++;
    }
  };
}
