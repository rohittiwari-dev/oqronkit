import {
	CronContext,
	type CronDefinition,
	type Logger,
	OqronContainer,
} from "../engine/index.js";
import { BaseSchedulerEngine } from "./base-scheduler-engine.js";
import { getNextRunDate } from "./expression-parser.js";
import { MissedFireHandler } from "./missed-fire.handler.js";

/**
 * CronEngine — schedules jobs via cron expressions or fixed intervals.
 *
 * Extends BaseSchedulerEngine with cron-specific logic:
 * - `computeNextRun` uses cron-parser or intervalMs
 * - `handleLeaderInit` delegates to MissedFireHandler
 * - Context is CronContext (extends JobContext)
 */
export class CronEngine extends BaseSchedulerEngine<CronDefinition> {
	public readonly name = "cron";
	protected readonly moduleType = "cron";
	protected readonly queueName = "system_cron";
	protected readonly lockInfix = ":run:";
	protected readonly storageNamespace = "cron_schedules";

	private readonly missedFireHandler: MissedFireHandler;

	private readonly schedules = new Map<string, CronDefinition>();

	constructor(
		staticSchedules: CronDefinition[],
		logger?: Logger,
		environment?: string,
		project?: string,
		private readonly config?: {
			enable?: boolean;
			timezone?: string;
			tickInterval?: number;
			leaderElection?: boolean;
			keepJobHistory?: boolean | number;
			keepFailedJobHistory?: boolean | number;
			shutdownTimeout?: number;
			lagMonitor?: { maxLagMs?: number; sampleIntervalMs?: number };
			disabledBehavior?: import("../engine/index.js").DisabledBehavior;
			maxHeldJobs?: number;
		},
		container?: OqronContainer,
	) {
		super(logger, environment, project, config, container);
		for (const def of staticSchedules) {
			this.schedules.set(def.name, def);
		}
		this.missedFireHandler = new MissedFireHandler(this.logger);
	}

	// ── Abstract implementations ──────────────────────────────────────────────

	protected getDefinition(name: string): CronDefinition | undefined {
		return this.schedules.get(name);
	}

	protected computeNextRun(def: CronDefinition, from: Date): Date | null {
		if (def.expression) {
			try {
				const timezone = def.timezone ?? this.config?.timezone;
				return getNextRunDate(def.expression, timezone, from);
			} catch (err) {
				this.logger.error(
					"Failed to compute next run from expression",
					{
						name: def.name,
						expression: def.expression,
						err: String(err),
					},
				);
				return null;
			}
		}

		if (def.intervalMs) {
			return new Date(from.getTime() + def.intervalMs);
		}

		return null;
	}

	protected async handleLeaderInit(): Promise<void> {
		this.logger.info("Performing leader initialization...");

		const knownSchedules = await this.di.storage.list<any>(this.storageNamespace);
		const now = new Date();

		for (const record of knownSchedules) {
			const def = this.schedules.get(record.name);
			if (!def) continue;

			const result = await this.missedFireHandler.checkMissed(
				def,
				record.lastRunAt ? new Date(record.lastRunAt) : null,
				now,
			);
			if (result.missed) {
				this.logger.info(
					"Triggering recovery run(s) for missed schedule",
					{
						name: def.name,
						missedAt: record.nextRunAt,
						count: result.missedDates.length,
						policy: def.missedFire,
					},
				);

				for (const missedDate of result.missedDates) {
					void this.fire(def, missedDate);
				}

				const nextRun = this.computeNextRun(def, now);
				if (nextRun) {
					await this.di.storage.save(this.storageNamespace, def.name, {
						...record,
						nextRunAt: nextRun,
						lastRunAt: now,
					});
				}
			}
		}
	}

	async init(): Promise<void> {
		this.logger.info("Initializing scheduler (Unified Model)", {
			nodeId: this.nodeId,
			count: this.schedules.size,
		});

		for (const def of this.schedules.values()) {
			const existing = await this.di.storage.get<any>(
				this.storageNamespace,
				def.name,
			);

			let shouldRecompute =
				existing &&
				(existing.expression !== def.expression ||
					existing.intervalMs !== def.intervalMs);

			await this.di.storage.save(this.storageNamespace, def.name, {
				...(existing || {}),
				...def,
				nextRunAt: shouldRecompute ? null : existing?.nextRunAt,
				lastRunAt: existing?.lastRunAt,
				paused: existing?.paused ?? (def.status === "paused"),
			});
		}

		// Seed initial nextRunAt
		const existing = await this.di.storage.list<any>(this.storageNamespace);
		const now = new Date();

		for (const record of existing) {
			if (record.nextRunAt !== null && record.nextRunAt !== undefined)
				continue;

			const def = this.schedules.get(record.name);
			if (!def) continue;

			const nextRun = this.computeNextRun(def, now);
			if (nextRun) {
				await this.di.storage.save(this.storageNamespace, def.name, {
					...record,
					nextRunAt: nextRun,
				});
			}
		}
	}

	protected createExecutionContext(opts: {
		def: CronDefinition;
		runId: string;
		abort: AbortController;
		startedAt: Date;
		localLogs: Array<{ level: string; msg: string; ts: Date }>;
		localTimeline: Array<{ ts: Date; from: string; to: string; reason: string }>;
	}): any {
		return new CronContext({
			id: opts.runId,
			logger: this.logger.child({ schedule: opts.def.name }),
			signal: opts.abort.signal,
			firedAt: opts.startedAt,
			scheduleName: opts.def.name,
			environment: this.environment,
			project: this.project,
			onProgress: this.createOnProgress(opts.runId, opts.localLogs, opts.localTimeline),
			onLog: this.createOnLog(opts.def.name, opts.runId, opts.localLogs),
		});
	}
}
