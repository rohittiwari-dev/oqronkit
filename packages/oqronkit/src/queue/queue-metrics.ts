import { OqronEventBus } from "../engine/index.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface QueueMetricEntry {
	name: string;
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

export interface QueueMetricsSnapshot {
	timestamp: Date;
	totalQueues: number;
	totalProcessed: number;
	totalCompleted: number;
	totalFailed: number;
	queues: QueueMetricEntry[];
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

	getStats(): { min: number; max: number; avg: number; p95: number; p99: number; last: number } {
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

// ── Per-queue metric accumulator ─────────────────────────────────────────────

interface QueueAccumulator {
	name: string;
	processed: number;
	completed: number;
	failed: number;
	stalled: number;
	durations: DurationRingBuffer;
	lastProcessedAt?: Date;
}

// ── Main Metrics Class ───────────────────────────────────────────────────────

/**
 * QueueMetrics — lightweight metrics collector for the queue module.
 *
 * Subscribes to OqronEventBus events and maintains per-queue counters and
 * duration histograms. Exposes structured snapshots via `getMetrics()` for
 * consumption by Prometheus, OpenTelemetry, or custom dashboards.
 *
 * Zero external dependencies. No background timers — all updates are event-driven.
 */
export class QueueMetrics {
	private readonly queues = new Map<string, QueueAccumulator>();
	private listening = false;

	/**
	 * Start listening to EventBus events.
	 * Safe to call multiple times — only subscribes once.
	 */
	start(): void {
		if (this.listening) return;
		this.listening = true;

		OqronEventBus.on("queue:job:claimed", this.handleClaimed);
		OqronEventBus.on("queue:job:completed", this.handleCompleted);
		OqronEventBus.on("queue:job:failed", this.handleFailed);
		OqronEventBus.on("job:stalled", this.handleStalled);
	}

	/** Stop listening to EventBus events. */
	stop(): void {
		if (!this.listening) return;
		this.listening = false;

		OqronEventBus.off("queue:job:claimed", this.handleClaimed);
		OqronEventBus.off("queue:job:completed", this.handleCompleted);
		OqronEventBus.off("queue:job:failed", this.handleFailed);
		OqronEventBus.off("job:stalled", this.handleStalled);
	}

	/** Get a full metrics snapshot for all tracked queues. */
	getMetrics(): QueueMetricsSnapshot {
		let totalProcessed = 0;
		let totalCompleted = 0;
		let totalFailed = 0;
		const queues: QueueMetricEntry[] = [];

		for (const acc of this.queues.values()) {
			totalProcessed += acc.processed;
			totalCompleted += acc.completed;
			totalFailed += acc.failed;

			queues.push({
				name: acc.name,
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
			totalQueues: this.queues.size,
			totalProcessed,
			totalCompleted,
			totalFailed,
			queues,
		};
	}

	/** Get metrics for a single queue by name. */
	getMetricsForQueue(name: string): QueueMetricEntry | undefined {
		const acc = this.queues.get(name);
		if (!acc) return undefined;

		return {
			name: acc.name,
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
		this.queues.clear();
	}

	// ── Private: ensure accumulator exists ────────────────────────────────

	private getOrCreate(name: string): QueueAccumulator {
		let acc = this.queues.get(name);
		if (!acc) {
			acc = {
				name,
				processed: 0,
				completed: 0,
				failed: 0,
				stalled: 0,
				durations: new DurationRingBuffer(),
			};
			this.queues.set(name, acc);
		}
		return acc;
	}

	// ── Event handlers (bound arrow functions for safe unsubscribe) ───────

	private handleClaimed = (queueName: string, _jobId: string): void => {
		const acc = this.getOrCreate(queueName);
		acc.processed++;
		acc.lastProcessedAt = new Date();
	};

	private handleCompleted = (queueName: string, _jobId: string, durationMs: number): void => {
		const acc = this.queues.get(queueName);
		if (!acc) return;
		acc.completed++;
		acc.durations.push(durationMs);
	};

	private handleFailed = (queueName: string, _jobId: string, durationMs: number): void => {
		const acc = this.queues.get(queueName);
		if (!acc) return;
		acc.failed++;
		acc.durations.push(durationMs);
	};

	private handleStalled = (queueName: string, _jobId: string): void => {
		const acc = this.queues.get(queueName);
		if (acc) {
			acc.stalled++;
		}
	};
}
