import type { Logger } from "../logger/index.js";
import type {
	IBrokerEngine,
	ILockAdapter,
	IStorageEngine,
} from "../types/engine.js";
import type { OqronJob } from "../types/job.types.js";
import { OqronEventBus } from "../events/event-bus.js";

/**
 * Phase 4: Storage-Broker Reconciliation Engine
 *
 * **Problem:** OqronKit decouples the Storage adapter (e.g. Postgres) from the
 * Broker adapter (e.g. Redis). During a retry, the engine saves `"delayed"` to
 * storage, then calls `broker.nack()`. If the process crashes between those two
 * lines, the job is orphaned — it's "delayed" in the DB but missing from the
 * broker. It will never execute again.
 *
 * **Solution:** This engine runs a periodic background scan (on a single leader
 * node via distributed mutex) that finds stale jobs and re-publishes them to
 * the broker.
 *
 * **What it scans:**
 * 1. `"waiting"` jobs older than `thresholdMs` — should have been claimed by now.
 *    If still waiting, likely missing from the broker. Re-publish.
 * 2. `"delayed"` jobs whose delay has expired — should have been promoted.
 *    If still delayed past their target time, re-publish.
 * 3. `"stalled"` jobs — should have been nacked by CrossNodeStallScanner but
 *    may have been missed. Re-publish.
 *
 * **Safety:**
 * - Uses a distributed lock (`oqron:reconciler`) so only ONE node runs the
 *   scan at a time (leader election via mutex).
 * - Re-publishing a job that is already in the broker is idempotent — the
 *   broker just has a duplicate ID in the queue. On claim, the engine checks
 *   job status from storage, so duplicates are harmlessly discarded.
 * - Emits `reconciliation:republished` events for observability.
 */

export interface ReconciliationConfig {
	/** How often to run the scan in ms. @default 120_000 (2 min) */
	intervalMs?: number;
	/**
	 * How long a "waiting" job must be stale before reconciliation.
	 * If a job has been in "waiting" status for longer than this, it's
	 * assumed to be missing from the broker.
	 * @default 300_000 (5 min)
	 */
	waitingThresholdMs?: number;
	/**
	 * How long past a delayed job's target time before reconciliation.
	 * @default 120_000 (2 min)
	 */
	delayedGraceMs?: number;
	/** Maximum number of jobs to reconcile per scan. @default 500 */
	batchSize?: number;
	/** Queue names to scope the scan to. If empty, scans all queues. */
	queueNames?: string[];
}

export class ReconciliationEngine {
	private timer?: ReturnType<typeof setInterval>;
	private scanning = false;
	private readonly leaderLockKey = "oqron:reconciler";
	private readonly leaderLockOwnerId: string;

	/** Counters for observability */
	private stats = {
		totalScans: 0,
		totalRepublished: 0,
		lastScanAt: null as Date | null,
		lastScanDurationMs: 0,
		lastScanRepublished: 0,
	};

	constructor(
		private readonly storage: IStorageEngine,
		private readonly broker: IBrokerEngine,
		private readonly lock: ILockAdapter,
		private readonly logger: Logger,
		private readonly config: ReconciliationConfig = {},
	) {
		this.leaderLockOwnerId = `reconciler-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	}

	/**
	 * Start the periodic reconciliation scan.
	 */
	start(): void {
		if (this.timer) return;

		const intervalMs = this.config.intervalMs ?? 120_000;

		this.logger.info("ReconciliationEngine started", {
			intervalMs,
			waitingThresholdMs: this.config.waitingThresholdMs ?? 300_000,
			delayedGraceMs: this.config.delayedGraceMs ?? 120_000,
		});

		this.timer = setInterval(async () => {
			if (this.scanning) return;
			this.scanning = true;

			try {
				await this.runScan();
			} catch (err) {
				this.logger.error("ReconciliationEngine scan error", {
					err: String(err),
				});
			} finally {
				this.scanning = false;
			}
		}, intervalMs);
		this.timer.unref();
	}

	/**
	 * Stop the reconciliation engine.
	 */
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	/**
	 * Run a single reconciliation scan. Public for testing.
	 * Returns the number of jobs re-published.
	 */
	async runScan(): Promise<number> {
		const scanStart = Date.now();

		// Acquire leader lock — only one node should scan at a time
		const lockTtlMs = Math.max(
			(this.config.intervalMs ?? 120_000) * 2,
			60_000,
		);
		const acquired = await this.lock.acquire(
			this.leaderLockKey,
			this.leaderLockOwnerId,
			lockTtlMs,
		);
		if (!acquired) {
			// Another node is already scanning
			return 0;
		}

		try {
			const batchSize = this.config.batchSize ?? 500;
			const now = Date.now();
			let totalRepublished = 0;

			// ── 1. Reconcile stale "waiting" jobs ────────────────────────────────
			totalRepublished += await this.reconcileWaiting(now, batchSize);

			// ── 2. Reconcile expired "delayed" jobs ──────────────────────────────
			totalRepublished += await this.reconcileDelayed(now, batchSize);

			// ── 3. Reconcile lingering "stalled" jobs ────────────────────────────
			totalRepublished += await this.reconcileStalled(batchSize);

			// ── Update stats ─────────────────────────────────────────────────────
			this.stats.totalScans++;
			this.stats.totalRepublished += totalRepublished;
			this.stats.lastScanAt = new Date();
			this.stats.lastScanDurationMs = Date.now() - scanStart;
			this.stats.lastScanRepublished = totalRepublished;

			if (totalRepublished > 0) {
				this.logger.info(
					`ReconciliationEngine: re-published ${totalRepublished} orphaned jobs`,
					{ durationMs: this.stats.lastScanDurationMs },
				);
			}

			return totalRepublished;
		} finally {
			// Release leader lock
			await this.lock.release(this.leaderLockKey, this.leaderLockOwnerId).catch(() => {});
		}
	}

	/**
	 * Get the current reconciliation statistics.
	 */
	getStats() {
		return { ...this.stats };
	}

	/** Whether a scan is currently in progress */
	get isScanning(): boolean {
		return this.scanning;
	}

	// ── Private: Reconcile "waiting" jobs ──────────────────────────────────

	private async reconcileWaiting(
		now: number,
		batchSize: number,
	): Promise<number> {
		const thresholdMs = this.config.waitingThresholdMs ?? 300_000;
		const cutoff = new Date(now - thresholdMs);

		// Find "waiting" jobs that were queued more than thresholdMs ago
		const staleJobs = await this.storage.list<OqronJob>(
			"jobs",
			{ status: "waiting" },
			{
				limit: batchSize,
				where: [{ field: "queuedAt", op: "$lt", value: cutoff }],
			},
		);

		// Filter by queueNames if configured
		const filtered = this.filterByQueues(staleJobs);
		let count = 0;

		for (const job of filtered) {
			try {
				await this.broker.publish(
					job.queueName,
					job.id,
					undefined,
					job.opts?.priority,
				);

				// Update timeline
				if (!job.timeline) job.timeline = [];
				job.timeline.push({
					ts: new Date(),
					from: "waiting",
					to: "waiting",
					reason: "Reconciliation: re-published to broker (stale waiting job)",
				});
				await this.storage.save("jobs", job.id, job);

				OqronEventBus.emit("job:retried", job.id, "reconciliation:waiting");
				count++;
			} catch (err) {
				this.logger.error("Failed to reconcile waiting job", {
					jobId: job.id,
					err: String(err),
				});
			}
		}

		return count;
	}

	// ── Private: Reconcile expired "delayed" jobs ─────────────────────────

	private async reconcileDelayed(
		now: number,
		batchSize: number,
	): Promise<number> {
		const graceMs = this.config.delayedGraceMs ?? 120_000;

		// Find "delayed" jobs — these should have a runAt or createdAt + delay
		const delayedJobs = await this.storage.list<OqronJob>(
			"jobs",
			{ status: "delayed" },
			{ limit: batchSize },
		);

		const filtered = this.filterByQueues(delayedJobs);
		let count = 0;

		for (const job of filtered) {
			// Determine when the job should have been promoted
			let shouldBeReadyAt: number;

			if (job.runAt) {
				shouldBeReadyAt = new Date(job.runAt).getTime();
			} else if (job.opts?.delay && job.createdAt) {
				shouldBeReadyAt =
					new Date(job.createdAt).getTime() + job.opts.delay;
			} else if (job.startedAt) {
				// Delayed due to retry — use startedAt + backoff delay estimate
				shouldBeReadyAt = new Date(job.startedAt).getTime() + 60_000;
			} else {
				// Can't determine target time — skip
				continue;
			}

			// Only reconcile if we're past the target time + grace period
			if (now < shouldBeReadyAt + graceMs) continue;

			try {
				// Re-publish as immediate (delay has already expired)
				job.status = "waiting";
				if (!job.timeline) job.timeline = [];
				job.timeline.push({
					ts: new Date(),
					from: "delayed",
					to: "waiting",
					reason: "Reconciliation: delay expired, re-published to broker",
				});
				await this.storage.save("jobs", job.id, job);

				await this.broker.publish(
					job.queueName,
					job.id,
					undefined,
					job.opts?.priority,
				);

				OqronEventBus.emit("job:retried", job.id, "reconciliation:delayed");
				count++;
			} catch (err) {
				this.logger.error("Failed to reconcile delayed job", {
					jobId: job.id,
					err: String(err),
				});
			}
		}

		return count;
	}

	// ── Private: Reconcile lingering "stalled" jobs ───────────────────────

	private async reconcileStalled(batchSize: number): Promise<number> {
		const stalledJobs = await this.storage.list<OqronJob>(
			"jobs",
			{ status: "stalled" },
			{ limit: batchSize },
		);

		const filtered = this.filterByQueues(stalledJobs);
		let count = 0;

		for (const job of filtered) {
			try {
				// Reset to waiting and re-publish
				job.status = "waiting";
				job.workerId = undefined;
				if (!job.timeline) job.timeline = [];
				job.timeline.push({
					ts: new Date(),
					from: "stalled",
					to: "waiting",
					reason: "Reconciliation: stalled job re-published to broker",
				});
				await this.storage.save("jobs", job.id, job);

				await this.broker.publish(
					job.queueName,
					job.id,
					undefined,
					job.opts?.priority,
				);

				OqronEventBus.emit("job:retried", job.id, "reconciliation:stalled");
				count++;
			} catch (err) {
				this.logger.error("Failed to reconcile stalled job", {
					jobId: job.id,
					err: String(err),
				});
			}
		}

		return count;
	}

	// ── Private: Filter by configured queue names ────────────────────────

	private filterByQueues(jobs: OqronJob[]): OqronJob[] {
		if (!this.config.queueNames?.length) return jobs;
		const allowed = new Set(this.config.queueNames);
		return jobs.filter((j) => allowed.has(j.queueName));
	}
}
