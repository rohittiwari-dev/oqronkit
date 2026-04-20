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
import type { WorkerModuleDef } from "../modules.js";
import { deregisterWorker, getRegisteredWorkers, registerWorker as registryRegister } from "./registry.js";
import type { WorkerConfig } from "./types.js";

export class WorkerEngine implements IOqronModule {
	public readonly name = "worker";
	public enabled = true;
	private running = false;
	private readonly workerIdStr = randomUUID();
	private activeJobs = new Map<string, Promise<void>>();
	private activeJobsByTopic = new Map<string, Set<string>>();
	private isPolling = new Set<string>();
	private abortControllers = new Map<string, AbortController>();
	private heartbeats = new Map<string, HeartbeatWorker>();
	private stallDetector: StallDetector | null = null;
	private timers: Array<ReturnType<typeof setInterval>> = [];
	/** Per-topic pause state — when true, poll is skipped for that topic */
	private pausedTopics = new Set<string>();
	/** Per-topic timers for cleanup on deregister */
	private topicTimers = new Map<string, NodeJS.Timeout>();

	constructor(
		private readonly config: OqronConfig,
		private readonly logger: Logger,
		private readonly workerModuleConfig: WorkerModuleDef,
	) {}

	private get di() {
		return OqronContainer.get();
	}

	async init(): Promise<void> {
		const ws = getRegisteredWorkers();
		this.logger.info(
			`Initialized WorkerEngine covering ${ws.length} topics`,
		);

		// Version-based config migration (§10.2 parity with schedule-engine)
		for (const w of ws) {
			const codeVersion = w.version ?? 0;
			const existing = await this.di.storage.get<any>("worker_instances", w.topic);
			const dbVersion = existing?.version ?? 0;

			if (existing && codeVersion > dbVersion) {
				this.logger.info("Worker config version upgraded", {
					topic: w.topic,
					from: dbVersion,
					to: codeVersion,
				});
				await this.di.storage.save("worker_instances", w.topic, {
					...(existing || {}),
					version: codeVersion,
					enabled: existing.enabled ?? true,
				});
				OqronEventBus.emit("worker:version-upgraded", w.topic, dbVersion, codeVersion);
			} else if (!existing) {
				// First registration — seed the instance record
				await this.di.storage.save("worker_instances", w.topic, {
					version: codeVersion,
					enabled: w.status !== "paused",
				});
			}
		}
	}

	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;

		for (const w of getRegisteredWorkers()) {
			this.startPolling(w);
		}

		// Stall detection runs universally for all guaranteed workers
		this.stallDetector = new StallDetector(
			this.di.lock,
			this.logger,
			this.workerModuleConfig.stalledInterval ?? 30000,
		);

		this.stallDetector.start(
			() => {
				const active: Array<{ key: string; ownerId: string }> = [];
				for (const [jobId, hb] of this.heartbeats.entries()) {
					if (hb.isActive) {
						active.push({
							key: `worker:job:${jobId}`,
							ownerId: this.workerIdStr,
						});
					}
				}
				return active;
			},
			async (key) => {
				const jobId = key.replace("worker:job:", "");
				await this.handleStalledJob(jobId);
			},
		);
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

	async triggerManual(id: string): Promise<boolean> {
		const w = getRegisteredWorkers().find((cw) => cw.topic === id);
		if (w) {
			await this.poll(w);
			return true;
		}
		return false;
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

		// Clean up per-topic and global active job tracking
		this.activeJobs.delete(jobId);
		for (const jobs of this.activeJobsByTopic.values()) {
			jobs.delete(jobId);
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

		this.stallDetector?.stop();
		this.stallDetector = null;

		// Abort all active jobs
		for (const controller of this.abortControllers.values()) {
			controller.abort();
		}
		this.abortControllers.clear();

		// Ensure all heartbeats stop regardless of drain success
		for (const hb of this.heartbeats.values()) {
			await hb.stop().catch(() => {});
		}
		this.heartbeats.clear();

		// B3: Graceful drain — wait for active jobs to settle before returning
		const allActive = Array.from(this.activeJobs.values());
		if (allActive.length > 0) {
			const timeout = this.workerModuleConfig.shutdownTimeout ?? 25_000;
			await Promise.race([
				Promise.allSettled(allActive),
				new Promise(r => { const h = setTimeout(r, timeout); h.unref(); }),
			]);
		}
	}

	// ── Phase 4: Dynamic CRUD Management Methods ────────────────────────────

	/**
	 * Dynamically register a new worker at runtime.
	 * Adds to registry, starts polling.
	 */
	registerWorker(config: WorkerConfig): void {
		registryRegister(config);
		if (this.running) {
			this.startPolling(config);
		}
		OqronEventBus.emit("worker:registered", config.topic);
		this.logger.info(`Worker "${config.topic}" dynamically registered`);
	}

	/**
	 * Remove a worker from the registry. Does NOT drain active jobs.
	 */
	deregisterWorker(topic: string): boolean {
		const timer = this.topicTimers.get(topic);
		if (timer) {
			clearInterval(timer);
			this.topicTimers.delete(topic);
		}
		const removed = deregisterWorker(topic);
		if (removed) {
			OqronEventBus.emit("worker:deregistered", topic);
			this.logger.info(`Worker "${topic}" dynamically deregistered`);
		}
		return removed;
	}

	/**
	 * Pause a worker — stops claiming new jobs for this topic.
	 */
	pauseWorker(topic: string): void {
		this.pausedTopics.add(topic);
		OqronEventBus.emit("worker:paused", topic);
		this.logger.info(`Worker "${topic}" paused`);
	}

	/**
	 * Resume a paused worker.
	 */
	resumeWorker(topic: string): void {
		this.pausedTopics.delete(topic);
		OqronEventBus.emit("worker:resumed", topic);
		this.logger.info(`Worker "${topic}" resumed`);
	}

	/**
	 * Get the current state of a specific worker.
	 */
	getWorkerState(topic: string): {
		topic: string;
		enabled: boolean;
		activeJobs: number;
		concurrency: number;
	} | undefined {
		const w = getRegisteredWorkers().find((cw) => cw.topic === topic);
		if (!w) return undefined;
		return {
			topic: w.topic,
			enabled: !this.pausedTopics.has(topic),
			activeJobs: this.activeJobsByTopic.get(topic)?.size ?? 0,
			concurrency: w.concurrency ?? this.workerModuleConfig.concurrency ?? 5,
		};
	}

	/**
	 * List state for all registered workers.
	 */
	listWorkers(): Array<{
		topic: string;
		enabled: boolean;
		activeJobs: number;
		concurrency: number;
	}> {
		return getRegisteredWorkers().map((w) => ({
			topic: w.topic,
			enabled: !this.pausedTopics.has(w.topic),
			activeJobs: this.activeJobsByTopic.get(w.topic)?.size ?? 0,
			concurrency: w.concurrency ?? this.workerModuleConfig.concurrency ?? 5,
		}));
	}

	private startPolling(w: WorkerConfig) {
		// W4: Use pollIntervalMs if set, fall back to heartbeatMs
		const pollIntervalMs = w.pollIntervalMs ?? w.heartbeatMs ?? this.workerModuleConfig.heartbeatMs ?? 5000;
		const t = setInterval(() => {
			this.poll(w).catch((e) =>
				this.logger.error("Worker poll error", {
					topic: w.topic,
					err: String(e),
				}),
			);
		}, pollIntervalMs);
		t.unref();
		this.timers.push(t);
		this.topicTimers.set(w.topic, t);
		// B4: Immediate first poll so jobs don't wait up to pollIntervalMs
		setTimeout(() => this.poll(w), 0);
	}

	private async poll(w: WorkerConfig): Promise<void> {
		if (!this.running || !this.enabled) return;
		if (this.pausedTopics.has(w.topic)) return;
		if (this.isPolling.has(w.topic)) return;

		this.isPolling.add(w.topic);
		try {
			const isSkipLocal = w.disabledBehavior === "skip";
			if (isSkipLocal) {
				await this.flushTopic(w.topic);
				return;
			}

			const concurrency =
				w.concurrency ?? this.workerModuleConfig.concurrency ?? 5;
			const currentActive = this.activeJobsByTopic.get(w.topic)?.size ?? 0;
			const freeSlots = concurrency - currentActive;
			
			if (freeSlots <= 0) return;

			const strategy: BrokerStrategy =
				w.strategy ?? this.workerModuleConfig.strategy ?? "fifo";
			const lockTtlMs = w.lockTtlMs ?? this.workerModuleConfig.lockTtlMs ?? 30_000;

			const claimedIds = await this.di.broker.claim(
				w.topic, // Broker queue is mapped to worker topic
				this.workerIdStr,
				freeSlots,
				lockTtlMs,
				strategy,
			);

			if (!claimedIds.length) return;

			for (const id of claimedIds) {
				const raw = await this.di.storage.get<OqronJob>("jobs", id);
				if (!raw) {
					// Job in broker but not in DB (orphan), ack to clean it up
					await this.di.broker.ack(w.topic, id);
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
					await this.di.broker.nack(w.topic, id);
					continue;
				}

				// Track in per-topic active set
				if (!this.activeJobsByTopic.has(w.topic)) {
					this.activeJobsByTopic.set(w.topic, new Set());
				}
				this.activeJobsByTopic.get(w.topic)!.add(id);

				// Phase 5: Emit claimed metric
				OqronEventBus.emit("worker:job:claimed", w.topic, id);

				const startTs = Date.now();
				const p = this.delegateExecuteJob(job, w).then(() => {
					const durationMs = Date.now() - startTs;
					OqronEventBus.emit("worker:job:completed", w.topic, id, durationMs);
				}).catch(() => {
					const durationMs = Date.now() - startTs;
					OqronEventBus.emit("worker:job:failed", w.topic, id, durationMs);
				}).finally(() => {
					this.activeJobs.delete(id);
					this.activeJobsByTopic.get(w.topic)?.delete(id);
				});
				this.activeJobs.set(id, p);
			}
		} finally {
			this.isPolling.delete(w.topic);
		}
	}

	private async handleStalledJob(jobId: string) {
		const raw = await this.di.storage.get<OqronJob>("jobs", jobId);
		if (!raw || raw.status !== "active") return;
		const job = raw;

		if (
			job.project &&
			this.config.project &&
			job.project !== this.config.project
		) {
			return; // Not our project
		}

		if (!this.enabled) return;

		// W3: Match by moduleName first, fall back to queueName if moduleName is missing
		const w = getRegisteredWorkers().find(
			(cw) => cw.topic === job.moduleName || cw.topic === job.queueName,
		);
		if (!w) return; // We don't have a handler registered for this worker topic

		if (w.disabledBehavior === "skip") {
			return;
		}

		const maxStalled = this.workerModuleConfig.maxStalledCount ?? 1;
		const stalledCount = (job.stalledCount ?? 0) + 1;

		if (stalledCount > maxStalled) {
			this.logger.error("Job exceeded max stall retries, failing", {
				jobId,
				stalledCount,
			});
			job.status = "failed";
			job.error = "Max stall retries exceeded (Worker crashed)";
			job.finishedAt = new Date();
			await this.di.storage.save("jobs", jobId, job);
			// Assume it's unacked in broker, or was lost.
			return;
		}

		job.stalledCount = stalledCount;
		await this.di.storage.save("jobs", jobId, job);

		this.logger.info("Re-queueing stalled worker job", { jobId });
		await this.di.broker.nack(w.topic, jobId);
	}

	private async flushTopic(topic: string) {
		const claimed = await this.di.broker.claim(topic, this.workerIdStr, 5, 30_000);
		for (const id of claimed) {
			const job = await this.di.storage.get<OqronJob>("jobs", id);
			if (job) {
				job.status = "failed";
				job.error = "Skipped because worker has disabledBehavior='skip'";
				job.finishedAt = new Date();
				await this.di.storage.save("jobs", job.id, job);
			}
			await this.di.broker.ack(topic, id);
		}
	}

	/**
	 * Delegates to the shared JobExecutor, which handles heartbeat, context,
	 * handler invocation, retry/nack/DLQ, finalization, hooks, and pruning.
	 */
	private async delegateExecuteJob(job: OqronJob, w: WorkerConfig): Promise<void> {
		const handlerConfig: JobHandlerConfig = {
			name: w.topic,
			handler: w.handler,
			guaranteedWorker: w.guaranteedWorker,
			heartbeatMs: w.heartbeatMs,
			lockTtlMs: w.lockTtlMs,
			timeout: w.timeout,
			tags: w.tags,
			retries: w.retries,
			rateLimiter: w.rateLimiter,
			deadLetter: w.deadLetter,
			hooks: w.hooks,
			condition: w.condition,
			removeOnComplete: w.removeOnComplete,
			removeOnFail: w.removeOnFail,
		};

		const execCtx: JobExecutionContext = {
			di: this.di,
			logger: this.logger,
			workerId: this.workerIdStr,
			environment: this.config.environment ?? "default",
			project: this.config.project ?? "default",
			handlerConfig,
			moduleDefaults: this.workerModuleConfig,
			heartbeats: this.heartbeats,
			abortControllers: this.abortControllers,
			lockPrefix: "worker", // Uses "worker:" for lock keys
		};

		await executeJob(job, execCtx);
	}
}
