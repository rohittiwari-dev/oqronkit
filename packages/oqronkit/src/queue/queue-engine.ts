import { randomUUID } from "node:crypto";
import type { IOqronModule, Logger } from "../engine/index.js";
import { OqronContainer, OqronEventBus } from "../engine/index.js";
import { HeartbeatWorker } from "../engine/lock/heartbeat-worker.js";
import { StallDetector } from "../engine/lock/stall-detector.js";
import type { OqronConfig } from "../engine/types/config.types.js";
import type { BrokerStrategy } from "../engine/types/engine.js";
import type { OqronJob } from "../engine/types/job.types.js";
import {
  executeJob,
  type JobExecutionContext,
  type JobHandlerConfig,
} from "../engine/utils/job-executor.js";
import type { QueueModuleDef } from "../modules.js";
import { getRegisteredQueues } from "./registry.js";
import type { QueueConfig } from "./types.js";

export class QueueEngine implements IOqronModule {
	public readonly name = "queue";
	public enabled = true;
	private running = false;
	private timers: NodeJS.Timeout[] = [];
	private workerIdStr = randomUUID();
	/** All active job promises — used for drain during shutdown */
	private activeJobs = new Map<string, Promise<void>>();
	/** Per-queue active job tracking — ensures concurrency is isolated per queue */
	private activeJobsByQueue = new Map<string, Set<string>>();
	private isPolling = new Set<string>();
	/** Active heartbeat workers keyed by job ID — for crash-safe lock renewal */
	private heartbeats = new Map<string, HeartbeatWorker>();
	/** AbortControllers keyed by job ID — for mid-execution cancellation */
	private abortControllers = new Map<string, AbortController>();
	/** Stall detector — reclaims jobs whose heartbeat locks have expired */
	private stallDetector: StallDetector | null = null;

	constructor(
		private config: OqronConfig,
		private logger: Logger,
		private queueConfig?: QueueModuleDef,
		private container?: OqronContainer,
	) {}

	private get di(): OqronContainer {
		return this.container ?? OqronContainer.get();
	}

	async init(): Promise<void> {
		const qs = getRegisteredQueues();
		this.logger.info(
			`Initialized QueueEngine covering ${qs.length} endpoints`,
		);
	}

	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;

		const qs = getRegisteredQueues();
		for (const q of qs) {
			this.startPolling(q);
		}

		// Start stall detector — checks for jobs whose heartbeat locks have expired
		const stalledInterval = this.queueConfig?.stalledInterval ?? 30000;

		this.stallDetector = new StallDetector(
			this.di.lock,
			this.logger,
			stalledInterval,
		);
		this.stallDetector.start(
			() =>
				Array.from(this.heartbeats.entries()).map(([jobId, _hb]) => ({
					key: `queue:job:${jobId}`,
					ownerId: this.workerIdStr,
				})),
			(key: string) => {
				// Extract jobId from lock key
				const jobId = key.replace("queue:job:", "");
				this.logger.warn(
					`Stall detected for Queue job ${jobId} — nacking back to broker`,
				);
				this.heartbeats.get(jobId)?.stop();
				this.heartbeats.delete(jobId);
				// Find the queue name for nack
				const queueName = qs.find((_q) =>
					this.activeJobs.has(jobId),
				)?.name;
				if (queueName) {
					// Increment stalledCount and update telemetry before returning to broker
					this.di.storage
						.get<any>("jobs", jobId)
						.then(async (job) => {
							if (job) {
								job.stalledCount = (job.stalledCount ?? 0) + 1;
								if (!job.timeline) job.timeline = [];
								job.timeline.push({
									ts: new Date(),
									from: job.status,
									to: "stalled",
									reason: `Worker lock expired. Re-enqueuing.`,
								});
								job.status = "stalled";
								try {
									await this.di.storage.save(
										"jobs",
										jobId,
										job,
									);
								} catch (e) {
									this.logger.error(
										"Failed to commit stall telemetry",
										{
											jobId,
											error: String(e),
										},
									);
								}
							}
						})
						.finally(() => {
							void this.di.broker.nack(queueName, jobId);
						});
				}
			},
		);
	}

	async triggerManual(id: string): Promise<boolean> {
		const q = getRegisteredQueues().find((q) => q.name === id);
		if (q) {
			await this.poll(q);
			return true;
		}
		return false;
	}

	async enable(): Promise<void> {
		this.enabled = true;
		if (!this.running) {
			await this.start();
		}
	}

	async disable(): Promise<void> {
		this.enabled = false;
	}

	/**
	 * Cancel an actively running job via AbortController.
	 * Aborts the handler, stops the heartbeat, and marks the job as failed.
	 */
	async cancelActiveJob(jobId: string): Promise<boolean> {
		const controller = this.abortControllers.get(jobId);
		if (!controller) return false;

		controller.abort();
		this.abortControllers.delete(jobId);

		// Stop heartbeat
		const hb = this.heartbeats.get(jobId);
		if (hb) {
			await hb.stop();
			this.heartbeats.delete(jobId);
		}

		// Mark job as failed/cancelled in storage
		const job = await this.di.storage.get<OqronJob>("jobs", jobId);
		if (job) {
			job.status = "failed";
			job.error = "Cancelled";
			job.finishedAt = new Date();
			await this.di.storage.save("jobs", jobId, job);

			// Ack from broker so it's not re-processed
			await this.di.broker.ack(job.queueName, jobId);
			OqronEventBus.emit(
				"job:fail",
				job.queueName,
				jobId,
				new Error("Cancelled"),
			);
		}

		return true;
	}

	async stop(): Promise<void> {
		this.running = false;
		for (const t of this.timers) clearInterval(t);
		this.timers = [];

		// Stop stall detector
		this.stallDetector?.stop();
		this.stallDetector = null;

		// Abort all active jobs
		for (const controller of this.abortControllers.values()) {
			controller.abort();
		}
		this.abortControllers.clear();

		// Stop all active heartbeats
		for (const hb of this.heartbeats.values()) {
			await hb.stop();
		}
		this.heartbeats.clear();

		const allActive = Array.from(this.activeJobs.values());
		if (allActive.length > 0) {
			this.logger.info(
				`QueueEngine draining ${allActive.length} active jobs...`,
			);
			const timeout = this.queueConfig?.shutdownTimeout ?? 25000;
			await Promise.race([
				Promise.allSettled(allActive),
				new Promise((r) => {
					const h = setTimeout(r, timeout);
					h.unref();
				}),
			]);
		}
	}

	private startPolling(q: QueueConfig) {
		// Publisher-only queues have no handler — skip polling entirely.
		// These queues only push jobs; a separate Worker node consumes them.
		if (!q.handler) {
			this.logger.info(
				`Queue "${q.name}" has no handler — running in publisher-only mode (no polling)`,
			);
			return;
		}

		const heartbeatMs =
			q.heartbeatMs ?? this.queueConfig?.heartbeatMs ?? 5000;
		const t = setInterval(() => {
			this.poll(q).catch((e) =>
				this.logger.error(`Queue poller crashed for ${q.name}`, e),
			);
		}, heartbeatMs);
		t.unref();
		this.timers.push(t);
		setTimeout(() => this.poll(q), 0);
	}

	private async poll(q: QueueConfig): Promise<void> {
		if (!this.running || !this.enabled) return;
		if (this.isPolling.has(q.name)) return;

		this.isPolling.add(q.name);
		try {
			const concurrency = q.concurrency ?? this.queueConfig?.concurrency ?? 5;
			const lockTtlMs = q.lockTtlMs ?? this.queueConfig?.lockTtlMs ?? 30000;

			// Per-queue concurrency: count only active jobs for THIS queue, not all queues
			const activeForQueue = this.activeJobsByQueue.get(q.name)?.size ?? 0;
			const freeSlots = concurrency - activeForQueue;
			if (freeSlots <= 0) return;

			// 1. Claim IDs from Broker with ordering strategy
			const strategy: BrokerStrategy =
				q.strategy ?? this.queueConfig?.strategy ?? "fifo";
			const jobIds = await this.di.broker.claim(
				q.name,
				this.workerIdStr,
				freeSlots,
				lockTtlMs,
				strategy,
			);

			if (jobIds.length === 0) return;

			// 2. Fetch job data & Execute
			for (const id of jobIds) {
				const raw = await this.di.storage.get("jobs", id);
				if (!raw) {
					// Orphan in broker — ack to eliminate
					await this.di.broker.ack(q.name, id);
					continue;
				}
				const job = raw as OqronJob;

				// Verify environment matches (or job has no env bounds)
				if (
					job.environment &&
					this.config.environment &&
					job.environment !== this.config.environment
				) {
					this.logger.warn(`Returning job ${id} — wrong environment`, {
						jobEnv: job.environment,
						workerEnv: this.config.environment,
					});
					await this.di.broker.nack(q.name, id);
					continue;
				}

				// Track in per-queue active set
				if (!this.activeJobsByQueue.has(q.name)) {
					this.activeJobsByQueue.set(q.name, new Set());
				}
				this.activeJobsByQueue.get(q.name)!.add(id);

				const p = this.delegateExecuteJob(job, q).finally(() => {
					this.activeJobs.delete(id);
					this.activeJobsByQueue.get(q.name)?.delete(id);
				});
				this.activeJobs.set(id, p);
			}
		} finally {
			this.isPolling.delete(q.name);
		}
	}

	/**
	 * Delegates to the shared JobExecutor, which handles heartbeat, context,
	 * handler invocation, retry/nack/DLQ, finalization, hooks, and pruning.
	 */
	private async delegateExecuteJob(job: OqronJob, q: QueueConfig): Promise<void> {
		if (!q.handler) return; // Safety guard — publisher-only queues never reach here

		const handlerConfig: JobHandlerConfig = {
			name: q.name,
			handler: q.handler,
			guaranteedWorker: q.guaranteedWorker,
			heartbeatMs: q.heartbeatMs,
			lockTtlMs: q.lockTtlMs,
			timeout: q.timeout,
			retries: q.retries,
			deadLetter: q.deadLetter,
			hooks: q.hooks,
			removeOnComplete: q.removeOnComplete,
			removeOnFail: q.removeOnFail,
		};

		const execCtx: JobExecutionContext = {
			di: this.di,
			logger: this.logger,
			workerId: this.workerIdStr,
			environment: this.config.environment ?? "default",
			project: this.config.project ?? "default",
			handlerConfig,
			moduleDefaults: this.queueConfig ?? {},
			heartbeats: this.heartbeats,
			abortControllers: this.abortControllers,
			lockPrefix: "queue",
		};

		await executeJob(job, execCtx);
	}
}
