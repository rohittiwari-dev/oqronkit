import { randomUUID } from "node:crypto";
import {
	createLogger,
	type DisabledBehavior,
	type IOqronModule,
	LagMonitor,
	type Logger,
	OqronContainer,
	OqronEventBus,
} from "../engine/index.js";
import {
	HeartbeatWorker,
	LeaderElection,
	StallDetector,
} from "../engine/lock/index.js";
import {
	keepHistoryToRemoveConfig,
	pruneAfterCompletion,
} from "../engine/utils/job-retention.js";
import {
	CLUSTER_STALL_CHECK_INTERVAL_TICKS,
	DEFAULT_CLUSTER_STALL_TTL_MS,
	DEFAULT_HEARTBEAT_MS,
	DEFAULT_LAG_MAX_MS,
	DEFAULT_LAG_SAMPLE_INTERVAL_MS,
	DEFAULT_LEADER_TTL_MS,
	DEFAULT_LOCK_TTL_MS,
	DEFAULT_MAX_HELD_JOBS,
	DEFAULT_RETRY_BASE_DELAY_MS,
	DEFAULT_SHUTDOWN_TIMEOUT_MS,
	DEFAULT_STALL_DETECTOR_INTERVAL_MS,
	DEFAULT_TICK_INTERVAL_MS,
	MAX_HELD_JOBS_QUERY_LIMIT,
	STALL_GRACE_MS,
} from "./constants.js";

// ── Shared types ─────────────────────────────────────────────────────────────

export type ActiveJobEntry = {
	runId: string;
	lockKey: string;
	worker?: HeartbeatWorker;
	abort?: AbortController;
	promise?: Promise<void>;
};

/**
 * Minimal contract that both CronDefinition and ScheduleDefinition satisfy.
 * The base engine only accesses these fields — subclasses cast to their full type.
 */
export interface BaseDefinition {
	name: string;
	handler: (ctx: any) => Promise<any>;
	overlap?: "skip" | "run" | boolean;
	maxConcurrent?: number;
	guaranteedWorker?: boolean;
	lockTtlMs?: number;
	heartbeatMs?: number;
	timeout?: number;
	retries?: { max?: number; baseDelay?: number; strategy?: string };
	hooks?: {
		beforeRun?: (ctx: any) => Promise<void> | void;
		afterRun?: (ctx: any, result: any) => Promise<void> | void;
		onError?: (ctx: any, err: Error) => Promise<boolean | void> | boolean | void;
	};
	keepHistory?: boolean | number;
	keepFailedHistory?: boolean | number;
	tags?: string[];
	disabledBehavior?: DisabledBehavior;
	status?: string;
	payload?: unknown;
}

export interface BaseSchedulerConfig {
	enable?: boolean;
	tickInterval?: number;
	leaderElection?: boolean;
	keepJobHistory?: boolean | number;
	keepFailedJobHistory?: boolean | number;
	shutdownTimeout?: number;
	lagMonitor?: { maxLagMs?: number; sampleIntervalMs?: number };
	disabledBehavior?: DisabledBehavior;
	maxHeldJobs?: number;
}

// ── Abstract Base ────────────────────────────────────────────────────────────

/**
 * Abstract base class that captures ~85% of the shared logic between
 * CronEngine and ScheduleEngine. Subclasses implement the 7 abstract
 * methods that differ between the two scheduling paradigms.
 */
export abstract class BaseSchedulerEngine<
	TDef extends BaseDefinition,
> implements IOqronModule
{
	public abstract readonly name: string;
	public enabled = true;

	protected readonly nodeId: string;
	protected readonly logger: Logger;
	protected leader?: LeaderElection;
	protected stallDetector!: StallDetector;
	protected lagMonitor: LagMonitor;
	protected tickTimer?: ReturnType<typeof setInterval>;
	protected readonly activeJobs = new Map<string, ActiveJobEntry>();
	protected _hasRunLeaderInit = false;
	protected _tickCount = 0;

	constructor(
		logger: Logger | undefined,
		protected readonly environment?: string,
		protected readonly project?: string,
		protected readonly baseConfig?: BaseSchedulerConfig,
		protected readonly container?: OqronContainer,
	) {
		this.nodeId = randomUUID();
		this.logger =
			logger ?? createLogger({ level: "info" }, { module: "scheduler" });
		this.lagMonitor = new LagMonitor(
			this.logger,
			this.baseConfig?.lagMonitor?.maxLagMs ?? DEFAULT_LAG_MAX_MS,
			this.baseConfig?.lagMonitor?.sampleIntervalMs ?? DEFAULT_LAG_SAMPLE_INTERVAL_MS,
		);
	}

	protected get di(): OqronContainer {
		return this.container ?? OqronContainer.get();
	}

	protected get lockPrefix(): string {
		return `oqron:${this.project ?? "default"}:${this.environment ?? "development"}`;
	}

	// ── Abstract methods (subclass-specific) ──────────────────────────────────

	/** Module type identifier for job records (e.g. "cron", "schedule") */
	protected abstract readonly moduleType: string;
	/** Queue name for job records (e.g. "system_cron", "system_schedule") */
	protected abstract readonly queueName: string;
	/** Lock key infix (e.g. ":run:", ":schedule:run:") */
	protected abstract readonly lockInfix: string;

	/** Resolve a definition by name */
	protected abstract getDefinition(name: string): TDef | undefined;
	/** Compute the next run date for a definition */
	protected abstract computeNextRun(def: TDef, from: Date): Date | null;
	/** Perform leader-init logic (missed-fire recovery, etc.) */
	protected abstract handleLeaderInit(): Promise<void>;
	/** Initialize definitions in storage on boot */
	abstract init(): Promise<void>;
	/** Create the execution context for a handler invocation */
	protected abstract createExecutionContext(opts: {
		def: TDef;
		runId: string;
		abort: AbortController;
		startedAt: Date;
		localLogs: Array<{ level: string; msg: string; ts: Date }>;
		localTimeline: Array<{ ts: Date; from: string; to: string; reason: string }>;
	}): any;

	// ── Lifecycle (shared) ────────────────────────────────────────────────────

	async start(): Promise<void> {
		if (this.baseConfig?.leaderElection !== false) {
			this.leader = new LeaderElection(
				this.di.lock,
				this.logger,
				`${this.lockPrefix}:${this.name}:leader`,
				this.nodeId,
				DEFAULT_LEADER_TTL_MS,
			);
			await this.leader.start();
		}

		this.stallDetector = new StallDetector(
			this.di.lock,
			this.logger,
			DEFAULT_STALL_DETECTOR_INTERVAL_MS,
		);

		const interval = this.baseConfig?.tickInterval ?? DEFAULT_TICK_INTERVAL_MS;
		this.tickTimer = setInterval(() => {
			void this.tick();
		}, interval);
		this.tickTimer.unref();

		this.logger.info(`${this.name} engine started`, {
			nodeId: this.nodeId,
			interval,
		});

		this.lagMonitor.start();
		this.stallDetector.start(
			() =>
				Array.from(this.activeJobs.values()).map((j) => ({
					key: j.lockKey,
					ownerId: this.nodeId,
				})),
			(key) => {
				for (const [id, job] of this.activeJobs) {
					if (job.lockKey === key) {
						this.logger.error("Stalled job detected, aborting", {
							key,
							runId: id,
						});
						this.di.storage
							.get<any>("jobs", id)
							.then(async (dbJob) => {
								if (dbJob) {
									dbJob.stalledCount =
										(dbJob.stalledCount ?? 0) + 1;
									if (!dbJob.timeline) dbJob.timeline = [];
									dbJob.timeline.push({
										ts: new Date(),
										from: dbJob.status,
										to: "stalled",
										reason: "Worker lock expired. Job aborted.",
									});
									dbJob.status = "stalled";
									try {
										await this.di.storage.save("jobs", id, dbJob);
									} catch (e) {
										this.logger.error(
											"Failed to commit stall telemetry",
											{ runId: id, error: String(e) },
										);
									}
								}
							})
							.finally(() => {
								job.abort?.abort();
								this.activeJobs.delete(id);
							});
					}
				}
			},
		);
	}

	async stop(): Promise<void> {
		if (this.tickTimer) clearInterval(this.tickTimer);
		if (this.leader) await this.leader.stop();
		this.stallDetector.stop();
		this.lagMonitor.stop();

		const activePromises = Array.from(this.activeJobs.values())
			.map((job) => job.promise)
			.filter((p): p is Promise<void> => p !== undefined);

		if (activePromises.length > 0) {
			this.logger.info(
				`${this.name} draining ${activePromises.length} active jobs...`,
			);
			const drainMs = this.baseConfig?.shutdownTimeout ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
			const drainTimeout = new Promise<void>((r) => {
				const h = setTimeout(r, drainMs);
				h.unref();
			});
			await Promise.race([
				Promise.allSettled(activePromises),
				drainTimeout,
			]);
		}

		for (const job of this.activeJobs.values()) {
			if (job.abort) job.abort.abort();
			if (job.worker) {
				await job.worker.stop();
			} else {
				await this.di.lock
					.release(job.lockKey, this.nodeId)
					.catch(() => {});
			}
		}
		this.activeJobs.clear();
		this.logger.info(`${this.name} engine stopped`);
	}

	async triggerManual(scheduleId: string): Promise<boolean> {
		const def = this.getDefinition(scheduleId);
		if (!def) return false;
		this.logger.info("Manual trigger requested", { scheduleId });
		void this.fire(def);
		return true;
	}

	async enable(): Promise<void> {
		this.enabled = true;
		if (!this.tickTimer) {
			await this.start();
		}
	}

	async disable(): Promise<void> {
		this.enabled = false;
	}

	// ── Tick (shared structure) ───────────────────────────────────────────────

	protected async tick(): Promise<void> {
		if (!this.enabled) return;
		if (this.leader && !this.leader.isLeader) return;

		if (!this._hasRunLeaderInit) {
			this._hasRunLeaderInit = true;
			await this.handleLeaderInit();
		}

		try {
			if (this.lagMonitor.isCircuitTripped) {
				this.logger.debug("Tick skipped — event loop lag detected");
				return;
			}

			if (++this._tickCount % CLUSTER_STALL_CHECK_INTERVAL_TICKS === 0) {
				void this.detectClusterStalls();
			}

			const now = new Date();
			const allSchedules = await this.di.storage.list<any>("schedules");
			const due = allSchedules.filter(
				(s: any) => s.nextRunAt && new Date(s.nextRunAt) <= now,
			);

			for (const record of due) {
				const def = this.getDefinition(record.name);
				if (!def) continue;

				// ── Disabled behavior enforcement ──
				if (record.paused) {
					const behavior =
						def.disabledBehavior ??
						this.baseConfig?.disabledBehavior ??
						"hold";

					const nextRun = this.computeNextRun(def, now);
					if (nextRun) {
						await this.di.storage.save("schedules", def.name, {
							...record,
							nextRunAt: nextRun,
							lastRunAt: now,
						});
					}

					if (behavior === "skip") continue;

					if (behavior === "reject") {
						this.logger.warn(`${this.moduleType} fire rejected — instance is disabled`, {
							name: def.name,
							behavior: "reject",
						});
						OqronEventBus.emit(
							"job:fail",
							this.moduleType,
							record.name,
							new Error(`${def.name} is disabled and configured to reject fires`),
						);
						continue;
					}

					// behavior === "hold"
					await this.createHeldJob(def, now);
					continue;
				}

				// CRITICAL: Advance pointer BEFORE firing
				const nextRun = this.computeNextRun(def, now);
				if (!nextRun) {
					this.logger.error(
						"Cannot compute next run — suspending to prevent runaway loop",
						{ name: def.name },
					);
					await this.di.storage.save("schedules", def.name, {
						...record,
						nextRunAt: null,
					});
					continue;
				}

				await this.di.storage.save("schedules", def.name, {
					...record,
					nextRunAt: nextRun,
					lastRunAt: now,
				});

				void this.fire(def, now);
			}
		} catch (err) {
			this.logger.error("Tick error", { err: String(err) });
		}
	}

	// ── Cluster stall detection (shared) ──────────────────────────────────────

	protected async detectClusterStalls(): Promise<void> {
		try {
			const activeDbJobs = await this.di.storage.list<any>("jobs", {
				status: "running",
			});
			for (const job of activeDbJobs) {
				if (!job.scheduleId) continue;
				const def = this.getDefinition(job.scheduleId);
				if (!def?.guaranteedWorker) continue;

				const ageMs = Date.now() - new Date(job.startedAt).getTime();
				const ttl = def.lockTtlMs ?? DEFAULT_CLUSTER_STALL_TTL_MS;

				if (ageMs > ttl + STALL_GRACE_MS) {
					this.logger.warn("Cluster stall detected", {
						runId: job.id,
					});
					await this.di.storage.save("jobs", job.id, {
						...job,
						status: "failed",
						error: "Stall detected (lock assumed expired)",
						completedAt: new Date(),
					});
				}
			}
		} catch (err) {
			this.logger.error("Failed to detect cluster stalls", {
				err: String(err),
			});
		}
	}

	// ── Held job creation (shared) ────────────────────────────────────────────

	private async createHeldJob(def: TDef, now: Date): Promise<void> {
		const holdId = randomUUID();
		await this.di.storage.save("jobs", holdId, {
			id: holdId,
			type: this.moduleType,
			queueName: this.queueName,
			moduleName: def.name,
			scheduleId: def.name,
			status: "paused",
			pausedReason: "disabled-hold",
			data: def.payload ?? null,
			opts: {},
			attemptMade: 0,
			progressPercent: 0,
			workerId: this.nodeId,
			tags: def.tags ?? [],
			environment: this.environment ?? "default",
			project: this.project ?? "default",
			queuedAt: now,
			triggeredBy: this.moduleType,
			logs: [
				{
					level: "warn",
					msg: `${def.name} fired while disabled — job held`,
					ts: now,
				},
			],
			timeline: [
				{
					ts: now,
					from: "waiting",
					to: "paused",
					reason: "Instance disabled — hold",
				},
			],
			steps: [],
			createdAt: now,
		});

		// Prune excess held jobs
		const maxHeld = this.baseConfig?.maxHeldJobs ?? DEFAULT_MAX_HELD_JOBS;
		const heldJobs = await this.di.storage.list<any>(
			"jobs",
			{
				moduleName: def.name,
				status: "paused",
				pausedReason: "disabled-hold",
			},
			{ limit: MAX_HELD_JOBS_QUERY_LIMIT },
		);

		heldJobs.sort(
			(a: any, b: any) =>
				new Date(a.createdAt).getTime() -
				new Date(b.createdAt).getTime(),
		);

		if (heldJobs.length > maxHeld) {
			const toRemove = heldJobs.slice(0, heldJobs.length - maxHeld);
			for (const old of toRemove) {
				await this.di.storage.delete("jobs", old.id);
			}
		}

		this.logger.info(`${this.moduleType} fire held — instance is disabled`, {
			name: def.name,
			holdId,
		});
	}

	// ── Fire (shared orchestration) ───────────────────────────────────────────

	protected async fire(def: TDef, tickTime: Date = new Date()): Promise<void> {
		const isOverlapSkip = def.overlap === "skip" || def.overlap === false;
		const lockBase = `${this.lockPrefix}${this.lockInfix}${def.name}`;

		// Local overlap check
		if (isOverlapSkip) {
			for (const job of this.activeJobs.values()) {
				if (job.lockKey === lockBase) {
					this.logger.debug("Skipping overlapping run", { name: def.name });
					return;
				}
			}
		}

		// Concurrency rate limiting
		if (def.maxConcurrent) {
			let activeCount = 0;
			for (const job of this.activeJobs.values()) {
				if (job.lockKey.startsWith(lockBase)) activeCount++;
			}
			if (activeCount >= def.maxConcurrent) {
				this.logger.debug("Skipping — maxConcurrent reached", {
					name: def.name,
					active: activeCount,
					max: def.maxConcurrent,
				});
				return;
			}
		}

		const runId = randomUUID();
		const lockKey = isOverlapSkip
			? lockBase
			: `${lockBase}:${tickTime.getTime()}`;
		const startedAt = new Date();

		// ── Acquire lock ──
		let worker: HeartbeatWorker | undefined;
		let acquired = false;

		if (def.guaranteedWorker) {
			worker = new HeartbeatWorker(
				this.di.lock,
				this.logger,
				lockKey,
				this.nodeId,
				def.lockTtlMs ?? DEFAULT_LOCK_TTL_MS,
				def.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
			);
			acquired = await worker.start();
		} else {
			acquired = await this.di.lock.acquire(
				lockKey,
				this.nodeId,
				def.lockTtlMs ?? DEFAULT_LOCK_TTL_MS,
			);
		}

		if (!acquired) return;

		const abort = new AbortController();
		const entry: ActiveJobEntry = { runId, lockKey, worker, abort };
		this.activeJobs.set(runId, entry);

		// Persist initial running job state
		await this.di.storage.save("jobs", runId, {
			id: runId,
			type: this.moduleType,
			queueName: this.queueName,
			moduleName: def.name,
			scheduleId: def.name,
			status: "running",
			data: def.payload ?? null,
			opts: {},
			attemptMade: 0,
			progressPercent: 0,
			workerId: this.nodeId,
			tags: def.tags ?? [],
			environment: this.environment ?? "default",
			project: this.project ?? "default",
			queuedAt: new Date(),
			triggeredBy: this.moduleType,
			logs: [],
			timeline: [
				{
					ts: startedAt,
					from: "waiting",
					to: "running",
					reason: `${def.name} fired`,
				},
			],
			steps: [],
			startedAt,
		});

		// ── Execute handler (non-blocking) ──
		OqronEventBus.emit("job:start", this.queueName, runId, def.name);
		entry.promise = this.executeHandler(def, runId, lockKey, startedAt, worker, abort);
	}

	/**
	 * Handler execution: context creation, retry loop, telemetry, cleanup.
	 * Extracted from fire() to keep the method manageable.
	 */
	private async executeHandler(
		def: TDef,
		runId: string,
		lockKey: string,
		startedAt: Date,
		worker: HeartbeatWorker | undefined,
		abort: AbortController,
	): Promise<void> {
		const localLogs: Array<{ level: string; msg: string; ts: Date }> = [];
		const localTimeline: Array<{
			ts: Date;
			from: string;
			to: string;
			reason: string;
		}> = [];

		const ctx = this.createExecutionContext({
			def,
			runId,
			abort,
			startedAt,
			localLogs,
			localTimeline,
		});

		let status: "completed" | "failed" = "completed";
		let error: string | undefined;
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		let finalResult: unknown;
		let attempts = 1;
		const maxAttempts = (def.retries?.max ?? 0) + 1;

		while (attempts <= maxAttempts) {
			try {
				if (def.hooks?.beforeRun) await def.hooks.beforeRun(ctx);

				if (def.timeout) {
					const timeoutPromise = new Promise<never>((_, reject) => {
						timeoutHandle = setTimeout(() => {
							abort.abort();
							reject(
								new Error(`Handler timed out after ${def.timeout}ms`),
							);
						}, def.timeout);
					});
					finalResult = await Promise.race([
						def.handler(ctx),
						timeoutPromise,
					]);
				} else {
					finalResult = await def.handler(ctx);
				}

				if (def.hooks?.afterRun) {
					await def.hooks.afterRun(ctx, finalResult);
				}

				status = "completed";
				error = undefined;
				break;
			} catch (err: unknown) {
				error = err instanceof Error ? err.message : String(err);
				status = "failed";

				if (def.hooks?.onError && err instanceof Error) {
					try {
						await Promise.resolve(def.hooks.onError(ctx, err));
					} catch (e) {
						this.logger.error("onError hook threw", {
							err: String(e),
						});
					}
				}

				if (attempts < maxAttempts) {
					this.logger.warn("Handler threw, retrying...", {
						name: def.name,
						runId,
						attempt: attempts,
						error,
					});

					const baseDelay =
						def.retries?.baseDelay ?? DEFAULT_RETRY_BASE_DELAY_MS;
					const delay =
						def.retries?.strategy === "exponential"
							? baseDelay * 2 ** (attempts - 1)
							: baseDelay;

					attempts++;
					await new Promise((resolve) =>
						setTimeout(resolve, delay),
					);
				} else {
					this.logger.error("Handler failed completely", {
						name: def.name,
						runId,
						attempts,
						error,
					});
					break;
				}
			} finally {
				if (timeoutHandle) clearTimeout(timeoutHandle);
			}
		}

		// ── Persist final telemetry ──
		const finishedAt = new Date();
		const existingJob =
			(await this.di.storage.get<any>("jobs", runId)) ?? {};

		localTimeline.push({
			ts: finishedAt,
			from: "running",
			to: status,
			reason:
				status === "failed"
					? (error ?? "Unknown error")
					: "Finished successfully",
		});

		const mergedTimeline = [
			...(existingJob.timeline || []),
			...localTimeline,
		];
		const mergedLogs = [...(existingJob.logs || []), ...localLogs];

		await this.di.storage.save("jobs", runId, {
			...existingJob,
			id: runId,
			type: this.moduleType,
			queueName: this.queueName,
			moduleName: def.name,
			scheduleId: def.name,
			status,
			data: def.payload ?? null,
			opts: {},
			attemptMade: attempts,
			progressPercent: status === "completed" ? 100 : 0,
			progressLabel: status === "completed" ? "Completed" : undefined,
			workerId: this.nodeId,
			tags: def.tags ?? [],
			environment: this.environment ?? "default",
			project: this.project ?? "default",
			returnValue:
				finalResult !== undefined ? finalResult : undefined,
			durationMs: finishedAt.getTime() - startedAt.getTime(),
			error,
			stacktrace: error && status === "failed" ? [error] : undefined,
			createdAt: startedAt,
			queuedAt: existingJob.queuedAt ?? startedAt,
			startedAt,
			processedOn: startedAt,
			finishedAt,
			logs: mergedLogs,
			timeline: mergedTimeline,
		});

		// ── Cleanup ──
		if (worker) {
			await worker.stop();
		} else {
			await this.di.lock
				.release(lockKey, this.nodeId)
				.catch(() => {});
		}

		this.activeJobs.delete(runId);

		// History pruning
		const keepHistory =
			def.keepHistory ?? this.baseConfig?.keepJobHistory ?? true;
		const keepFailed =
			def.keepFailedHistory ??
			this.baseConfig?.keepFailedJobHistory ??
			true;

		await pruneAfterCompletion({
			namespace: "jobs",
			jobId: runId,
			status,
			jobRemoveConfig: keepHistoryToRemoveConfig(
				status === "completed" ? keepHistory : keepFailed,
			),
			filterKey: "scheduleId",
			filterValue: def.name,
		});

		this.logger.info("Job finished", {
			name: def.name,
			runId,
			status,
			attempts,
		});

		if (status === "completed") {
			OqronEventBus.emit("job:success", this.queueName, runId);
		} else {
			OqronEventBus.emit(
				"job:fail",
				this.queueName,
				runId,
				new Error(error ?? "Unknown error"),
			);
		}
	}

	// ── Shared progress/log callback factory ──────────────────────────────────

	/** Creates the onProgress callback for context construction. */
	protected createOnProgress(
		runId: string,
		localLogs: Array<{ level: string; msg: string; ts: Date }>,
		localTimeline: Array<{ ts: Date; from: string; to: string; reason: string }>,
	): (percent: number, label?: string) => Promise<void> {
		return async (percent, label) => {
			try {
				localTimeline.push({
					ts: new Date(),
					from: "running",
					to: "running",
					reason: `Progress: ${percent}% ${label || ""}`,
				});
				const job = await this.di.storage.get<any>("jobs", runId);
				if (job) {
					await this.di.storage.save("jobs", runId, {
						...job,
						progressPercent: percent,
						progressLabel: label,
						timeline: [...(job.timeline || []), ...localTimeline],
						logs: [...(job.logs || []), ...localLogs],
					});
					localTimeline.length = 0;
					localLogs.length = 0;
				}
			} catch (err) {
				this.logger.error("Failed to update progress", { runId, err });
			}
		};
	}

	/** Creates the onLog callback for context construction. */
	protected createOnLog(
		defName: string,
		runId: string,
		localLogs: Array<{ level: string; msg: string; ts: Date }>,
	): (level: string, msg: string) => void {
		return (level, msg) => {
			(this.logger as any)[level]?.(`[${this.moduleType}:${defName}] ${msg}`, {
				runId,
			});
			localLogs.push({ level, msg, ts: new Date() });
		};
	}
}
