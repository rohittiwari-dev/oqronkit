import { OqronEventBus } from "../engine/index.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface WorkerMetricEntry {
  topic: string;
  processed: number;
  completed: number;
  failed: number;
  stalled: number;
  duration: {
    min: number;
    max: number;
    avg: number;
    p95: number;
    p99: number;
    last: number;
  };
  lastProcessedAt?: Date;
}

export interface WorkerMetricsSnapshot {
  timestamp: Date;
  totalWorkers: number;
  totalProcessed: number;
  totalCompleted: number;
  totalFailed: number;
  workers: WorkerMetricEntry[];
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

// ── Per-worker metric accumulator ────────────────────────────────────────────

interface WorkerAccumulator {
  topic: string;
  processed: number;
  completed: number;
  failed: number;
  stalled: number;
  durations: DurationRingBuffer;
  lastProcessedAt?: Date;
}

// ── Main Metrics Class ───────────────────────────────────────────────────────

/**
 * WorkerMetrics — lightweight metrics collector for the worker module.
 *
 * Subscribes to OqronEventBus events and maintains per-topic counters and
 * duration histograms. Exposes structured snapshots via `getMetrics()` for
 * consumption by Prometheus, OpenTelemetry, or custom dashboards.
 *
 * Zero external dependencies. No background timers — all updates are event-driven.
 */
export class WorkerMetrics {
  private readonly workers = new Map<string, WorkerAccumulator>();
  private listening = false;

  /**
   * Start listening to EventBus events.
   * Safe to call multiple times — only subscribes once.
   */
  start(): void {
    if (this.listening) return;
    this.listening = true;

    OqronEventBus.on("worker:job:claimed", this.handleClaimed);
    OqronEventBus.on("worker:job:completed", this.handleCompleted);
    OqronEventBus.on("worker:job:failed", this.handleFailed);
  }

  /** Stop listening to EventBus events. */
  stop(): void {
    if (!this.listening) return;
    this.listening = false;

    OqronEventBus.off("worker:job:claimed", this.handleClaimed);
    OqronEventBus.off("worker:job:completed", this.handleCompleted);
    OqronEventBus.off("worker:job:failed", this.handleFailed);
  }

  /** Get a full metrics snapshot for all tracked workers. */
  getMetrics(): WorkerMetricsSnapshot {
    let totalProcessed = 0;
    let totalCompleted = 0;
    let totalFailed = 0;
    const workers: WorkerMetricEntry[] = [];

    for (const acc of this.workers.values()) {
      totalProcessed += acc.processed;
      totalCompleted += acc.completed;
      totalFailed += acc.failed;

      workers.push({
        topic: acc.topic,
        processed: acc.processed,
        completed: acc.completed,
        failed: acc.failed,
        stalled: acc.stalled,
        duration: acc.durations.getStats(),
        lastProcessedAt: acc.lastProcessedAt,
      });
    }

    return {
      timestamp: new Date(),
      totalWorkers: this.workers.size,
      totalProcessed,
      totalCompleted,
      totalFailed,
      workers,
    };
  }

  /** Get metrics for a single worker by topic. */
  getMetricsForWorker(topic: string): WorkerMetricEntry | undefined {
    const acc = this.workers.get(topic);
    if (!acc) return undefined;

    return {
      topic: acc.topic,
      processed: acc.processed,
      completed: acc.completed,
      failed: acc.failed,
      stalled: acc.stalled,
      duration: acc.durations.getStats(),
      lastProcessedAt: acc.lastProcessedAt,
    };
  }

  /** Reset all collected metrics. Useful for testing. */
  resetMetrics(): void {
    this.workers.clear();
  }

  // ── Private: ensure accumulator exists ────────────────────────────────

  private getOrCreate(topic: string): WorkerAccumulator {
    let acc = this.workers.get(topic);
    if (!acc) {
      acc = {
        topic,
        processed: 0,
        completed: 0,
        failed: 0,
        stalled: 0,
        durations: new DurationRingBuffer(),
      };
      this.workers.set(topic, acc);
    }
    return acc;
  }

  // ── Event handlers (bound arrow functions for safe unsubscribe) ───────

  private handleClaimed = (topic: string, _jobId: string): void => {
    const acc = this.getOrCreate(topic);
    acc.processed++;
    acc.lastProcessedAt = new Date();
  };

  private handleCompleted = (
    topic: string,
    _jobId: string,
    durationMs: number,
  ): void => {
    const acc = this.workers.get(topic);
    if (!acc) return;
    acc.completed++;
    acc.durations.push(durationMs);
  };

  private handleFailed = (
    topic: string,
    _jobId: string,
    durationMs: number,
  ): void => {
    const acc = this.workers.get(topic);
    if (!acc) return;
    acc.failed++;
    acc.durations.push(durationMs);
  };
}
