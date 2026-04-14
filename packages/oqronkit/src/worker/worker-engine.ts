import { randomUUID } from "node:crypto";
import type { IOqronModule, Logger } from "../engine/index.js";
import { OqronContainer } from "../engine/index.js";
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
import { getRegisteredWorkers } from "./registry.js";
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

	constructor(
		private readonly config: OqronConfig,
		private readonly logger: Logger,
		private readonly workerModuleConfig: WorkerModuleDef,
	) {}

	private get di() {
		return OqronContainer.get();
	}

	async init(): Promise<void> {
		this.logger.info(
			`Initialized WorkerEngine covering ${
				getRegisteredWorkers().length
			} topics`,
		);
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
	}

	private startPolling(w: WorkerConfig) {
		const heartbeatMs = w.heartbeatMs ?? this.workerModuleConfig.heartbeatMs ?? 5000;
		const t = setInterval(() => {
			this.poll(w).catch((e) =>
				this.logger.error("Worker poll error", {
					topic: w.topic,
					err: String(e),
				}),
			);
		}, heartbeatMs);
		t.unref();
		this.timers.push(t);
	}

	private async poll(w: WorkerConfig): Promise<void> {
		if (!this.running || !this.enabled) return;
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

			const claimedIds = await this.di.broker.claim(
				w.topic, // Broker queue is mapped to worker topic
				this.workerIdStr,
				freeSlots,
				30000,
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

				const p = this.delegateExecuteJob(job, w).finally(() => {
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

		// A worker's job structure uses 'moduleName' matching the topic
		const w = getRegisteredWorkers().find((cw) => cw.topic === job.moduleName);
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
			retries: w.retries,
			deadLetter: w.deadLetter,
			hooks: w.hooks,
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
