import { RRule, rrulestr } from "rrule";
import {
  type DisabledBehavior,
  type Logger,
  type OqronContainer,
  OqronEventBus,
  ScheduleContext,
  type ScheduleDefinition,
} from "../engine/index.js";
import { ShardedLeaderElection, StallDetector } from "../engine/lock/index.js";
import { BaseSchedulerEngine } from "./base-scheduler-engine.js";
import {
  DEFAULT_INTERVAL_JITTER_FACTOR,
  DEFAULT_LEADER_TTL_MS,
  DEFAULT_MISFIRE_THRESHOLD_MS,
  DEFAULT_STALL_DETECTOR_INTERVAL_MS,
  DEFAULT_TICK_INTERVAL_MS,
} from "./constants.js";
import { _attachScheduleEngine } from "./define-schedule.js";
import { everyToIntervalMs as everyConfigToIntervalMs } from "./every-utils.js";

/**
 * ScheduleEngine — schedules jobs via RRule, every, runAt, recurring.
 *
 * Extends BaseSchedulerEngine with schedule-specific logic:
 * - `computeNextRun` uses RRule/every/runAt/recurring + jitter
 * - `handleLeaderInit` has misfire threshold + onMissedFire hooks
 * - Supports dynamic registration via `registerDynamic()`
 * - Supports sharded leader election for multi-region
 * - Context is ScheduleContext
 */
export class ScheduleEngine extends BaseSchedulerEngine<ScheduleDefinition> {
  public readonly name = "scheduler";
  protected readonly moduleType = "schedule";
  protected readonly queueName = "system_schedule";
  protected readonly lockInfix = ":schedule:run:";
  protected readonly storageNamespace = "schedule_schedules";

  private shardedLeader?: ShardedLeaderElection;
  private readonly schedules = new Map<string, ScheduleDefinition>();

  constructor(
    staticSchedules: ScheduleDefinition[],
    logger?: Logger,
    environment?: string,
    project?: string,
    private readonly config?: {
      enable?: boolean;
      tickInterval?: number;
      leaderElection?: boolean;
      keepJobHistory?: boolean | number;
      keepFailedJobHistory?: boolean | number;
      shutdownTimeout?: number;
      lagMonitor?: { maxLagMs?: number; sampleIntervalMs?: number };
      clustering?: {
        totalShards?: number;
        ownedShards?: number[];
        region?: string;
      };
      disabledBehavior?: DisabledBehavior;
      maxHeldJobs?: number;
      misfireThresholdMs?: number;
    },
    container?: OqronContainer,
  ) {
    super(logger, environment, project, config, container);
    for (const def of staticSchedules) {
      this.schedules.set(def.name, def);
    }
  }

  // ── Abstract implementations ──────────────────────────────────────────────

  protected getDefinition(name: string): ScheduleDefinition | undefined {
    return this.schedules.get(name);
  }

  protected setDefinition(name: string, def: ScheduleDefinition): void {
    this.schedules.set(name, def);
  }

  protected removeDefinition(name: string): void {
    this.schedules.delete(name);
  }

  protected validateDefinition(def: ScheduleDefinition): void {
    if ("runAfter" in (def as ScheduleDefinition & Record<string, unknown>)) {
      throw new Error(
        `[OqronKit] Schedule "${def.name}" uses removed option "runAfter". Use "runAt" for one-shot schedules or "every" for recurring intervals.`,
      );
    }

    const timingCount = [def.runAt, def.recurring, def.rrule, def.every].filter(
      (value) => value !== undefined,
    ).length;

    if (timingCount > 1) {
      throw new Error(
        `[OqronKit] Schedule "${def.name}" must use only one timing strategy: runAt, every, recurring, or rrule.`,
      );
    }

    if (def.runAt && Number.isNaN(new Date(def.runAt).getTime())) {
      throw new Error(
        `[OqronKit] Schedule "${def.name}" has an invalid runAt date`,
      );
    }

    if (def.every) {
      this.everyToIntervalMs(def);
    }
  }

  private everyToIntervalMs(def: ScheduleDefinition): number {
    const every = def.every;
    if (!every) return 0;
    return everyConfigToIntervalMs(every);
  }

  protected computeNextRun(def: ScheduleDefinition, from: Date): Date | null {
    try {
      if (def.runAt) {
        const d = new Date(def.runAt);
        return d > from ? d : null; // One-shot: null after firing prevents re-fire loop
      }

      if (def.rrule) {
        const rule = rrulestr(def.rrule);
        return rule.after(from);
      }

      if (def.recurring) {
        const freqMapHash: Record<string, any> = {
          daily: RRule.DAILY,
          weekly: RRule.WEEKLY,
          monthly: RRule.MONTHLY,
          yearly: RRule.YEARLY,
        };
        const freq = freqMapHash[def.recurring.frequency] ?? RRule.DAILY;
        const options: any = { freq };
        if (def.recurring.months?.length)
          options.bymonth = def.recurring.months;
        if (def.recurring.dayOfMonth)
          options.bymonthday = [def.recurring.dayOfMonth];
        if (def.recurring.at) {
          options.byhour = [def.recurring.at.hour];
          options.byminute = [def.recurring.at.minute];
          options.bysecond = [0];
        }
        const rule = new RRule(options);
        return rule.after(from);
      }

      if (def.every) {
        const add = this.everyToIntervalMs(def);
        const jitterFactor = DEFAULT_INTERVAL_JITTER_FACTOR;
        if (jitterFactor > 0) {
          const jitter = add * jitterFactor * (2 * Math.random() - 1);
          return new Date(from.getTime() + add + jitter);
        }
        return new Date(from.getTime() + add);
      }
    } catch (err) {
      this.logger.error("Failed to compute next run", {
        name: def.name,
        err: String(err),
      });
    }
    return null;
  }

  protected async handleLeaderInit(): Promise<void> {
    this.logger.info("Schedule Engine: Performing leader initialization...");

    try {
      const allSchedules = await this.di.storage.list<any>(
        this.storageNamespace,
      );
      const now = new Date();

      for (const record of allSchedules) {
        const def = this.schedules.get(record.name);
        if (!def) continue;
        if (def.runAt) continue;

        if (
          record.nextRunAt &&
          !record.paused &&
          new Date(record.nextRunAt) < now
        ) {
          const lateByMs = now.getTime() - new Date(record.nextRunAt).getTime();
          const misfireThreshold =
            this.config?.misfireThresholdMs ?? DEFAULT_MISFIRE_THRESHOLD_MS;
          if (lateByMs < misfireThreshold) {
            this.logger.debug(
              "Schedule late but within misfire threshold — skipping recovery",
              {
                name: def.name,
                lateByMs,
                threshold: misfireThreshold,
              },
            );
            continue;
          }

          const policy = def.missedFire ?? "skip";
          if (policy === "skip") {
            this.logger.info("Missed fire skipped per policy", {
              name: def.name,
            });
            const nextRun = this.computeNextRun(def, now);
            if (nextRun) {
              await this.di.storage.save(this.storageNamespace, def.name, {
                ...record,
                nextRunAt: nextRun,
                lastRunAt: now,
              });
            }
            continue;
          }

          this.logger.info("Triggering recovery for missed schedule", {
            name: def.name,
            missedAt: record.nextRunAt,
            policy,
          });

          if (def.hooks?.onMissedFire) {
            try {
              const missedAt = new Date(record.nextRunAt);
              const ctx = new ScheduleContext({
                id: `missed-${def.name}-${now.getTime()}`,
                scheduleName: def.name,
                firedAt: now,
                payload: def.payload,
                logger: this.logger.child({
                  schedule: def.name,
                  scope: "missed-fire",
                }),
                signal: new AbortController().signal,
                environment: this.environment,
                project: this.project,
              });
              await def.hooks.onMissedFire(ctx, missedAt);
            } catch (hookErr) {
              this.logger.error("onMissedFire hook threw", {
                name: def.name,
                err: String(hookErr),
              });
            }
          }

          if (policy === "run-all") {
            // Enumerate all missed occurrences using the shared MissedFireHandler
            const { MissedFireHandler } = await import(
              "./missed-fire.handler.js"
            );
            const mfh = new MissedFireHandler(this.logger);
            const mfResult = await mfh.checkMissed(
              {
                name: def.name,
                expression: record.expression,
                intervalMs: record.intervalMs,
                timezone: def.timezone,
                missedFire: def.missedFire,
                maxMissedRuns: def.maxMissedRuns,
              },
              record.lastRunAt ? new Date(record.lastRunAt) : null,
              now,
            );
            if (mfResult.missed) {
              const max = Math.min(
                mfResult.missedDates.length,
                def.maxMissedRuns ?? 100,
              );
              for (let i = 0; i < max; i++) {
                void this.fire(def, mfResult.missedDates[i]);
              }
            } else {
              // MissedFireHandler didn't detect missed dates — fire once as fallback
              void this.fire(def, now);
            }
          } else {
            // "run-once": fire the latest occurrence only
            void this.fire(def, now);
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
    } catch (err) {
      this.logger.error("Missed-fire recovery failed", { err: String(err) });
    }
  }

  // ── Init ────────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    this.logger.info("Initializing schedule engine", {
      nodeId: this.nodeId,
      staticCount: this.schedules.size,
    });

    _attachScheduleEngine(this);

    const now = new Date();
    for (const def of this.schedules.values()) {
      await this.upsertAndSeed(def, now);
    }
  }

  private async upsertAndSeed(def: ScheduleDefinition, now: Date) {
    this.validateDefinition(def);

    const existing = await this.di.storage.get<any>(
      this.storageNamespace,
      def.name,
    );

    const codeVersion = def.version ?? 0;
    const dbVersion = existing?.version ?? 0;

    //  Downgrade protection
    if (existing && codeVersion < dbVersion) {
      this.logger.warn("Code version is older than DB — skipping overwrite", {
        name: def.name,
        codeVersion,
        dbVersion,
      });
      return;
    }

    //  Version bump — controlled migration
    if (existing && codeVersion > dbVersion) {
      this.logger.info("Schedule version upgraded", {
        name: def.name,
        from: dbVersion,
        to: codeVersion,
      });

      await this.di.storage.save(this.storageNamespace, def.name, {
        ...def,
        version: codeVersion,
        // Preserve operational state
        paused: existing.paused ?? def.status === "paused",
        runCount: existing.runCount ?? 0,
        successCount: existing.successCount ?? 0,
        failCount: existing.failCount ?? 0,
        lastRunId: existing.lastRunId,
        lastStatus: existing.lastStatus,
        lastError: existing.lastError,
        lastDurationMs: existing.lastDurationMs,
        // Force recompute
        nextRunAt: null,
        lastRunAt: existing.lastRunAt,
        type: this.moduleType,
      });

      OqronEventBus.emit(
        "schedule:version-upgraded",
        def.name,
        dbVersion,
        codeVersion,
      );

      // Immediately compute new nextRunAt
      const nextRun = this.computeNextRun(def, now);
      if (nextRun) {
        const updated = await this.di.storage.get<any>(
          this.storageNamespace,
          def.name,
        );
        await this.di.storage.save(this.storageNamespace, def.name, {
          ...updated,
          nextRunAt: nextRun,
        });
      }
      return;
    }

    // Same version: standard upsert (preserve nextRunAt if config unchanged)
    let shouldRecompute = !existing?.nextRunAt;
    if (existing) {
      const cmp = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
      if (
        !cmp(existing.every, def.every) ||
        !cmp(existing.runAt, def.runAt) ||
        existing.rrule !== def.rrule ||
        !cmp(existing.recurring, def.recurring)
      ) {
        shouldRecompute = true;
      }
    }

    await this.di.storage.save(this.storageNamespace, def.name, {
      ...(existing || {}),
      ...def,
      version: codeVersion,
      nextRunAt: shouldRecompute ? null : existing?.nextRunAt,
      lastRunAt: existing?.lastRunAt,
      paused: existing?.paused ?? def.status === "paused",
    });

    if (shouldRecompute) {
      const nextRun = this.computeNextRun(def, now);
      if (nextRun) {
        const updated = await this.di.storage.get<any>(
          this.storageNamespace,
          def.name,
        );
        await this.di.storage.save(this.storageNamespace, def.name, {
          ...updated,
          nextRunAt: nextRun,
        });
      }
    }
  }

  // ── Sharded leader election override ────────────────────────────────────────

  async start(): Promise<void> {
    const clustering = this.config?.clustering;
    if (clustering && (clustering.totalShards ?? 1) > 1) {
      this.shardedLeader = new ShardedLeaderElection(
        this.di.lock,
        this.logger,
        `${this.lockPrefix}:scheduleengine:leader`,
        this.nodeId,
        clustering.totalShards!,
        clustering.ownedShards ?? [0],
        DEFAULT_LEADER_TTL_MS,
      );
      await this.shardedLeader.start();
      // Skip base start() leader election — we handle it here
      // But still need stallDetector, tick timer, lag monitor from base
      await this.startInfraOnly();
    } else {
      await super.start();
    }
  }

  /** Start only infrastructure (no leader election) — used when sharded leader is active */
  private async startInfraOnly(): Promise<void> {
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

    this.logger.info("Schedule engine started (sharded)", {
      nodeId: this.nodeId,
      interval,
      clustering: this.config?.clustering,
    });

    this.lagMonitor.start();
    this.metrics.start();
    this.stallDetector.start(
      () =>
        Array.from(this.activeJobs.values()).map((j) => ({
          key: j.lockKey,
          ownerId: this.nodeId,
        })),
      async (key) => {
        for (const [id, job] of this.activeJobs) {
          if (job.lockKey === key) {
            this.logger.error("Stalled schedule detected, aborting", {
              key,
              runId: id,
            });
            job.abort?.abort();
            this.activeJobs.delete(id);

            //  Persist stall telemetry (matching base class handler)
            try {
              const jobRecord = await this.di.storage.get<any>("jobs", id);
              if (jobRecord) {
                await this.di.storage.save("jobs", id, {
                  ...jobRecord,
                  stalledCount: (jobRecord.stalledCount ?? 0) + 1,
                  timeline: [
                    ...(jobRecord.timeline || []),
                    {
                      ts: new Date(),
                      from: jobRecord.status,
                      to: "stalled",
                      reason: `Lock expired for key ${key}`,
                    },
                  ],
                });
              }
            } catch (err) {
              this.logger.warn("Failed to persist stall telemetry", {
                runId: id,
                error: (err as Error).message,
              });
            }

            OqronEventBus.emit("job:stalled", this.queueName, id);
          }
        }
      },
    );
  }

  async stop(): Promise<void> {
    if (this.shardedLeader) await this.shardedLeader.stop();
    await super.stop();
  }

  // ── Dynamic registration (legacy compat — delegates to base CRUD) ──────────

  /** @deprecated Use `upsert(def)` instead. Kept for backward compatibility. */
  async registerDynamic(def: ScheduleDefinition): Promise<void> {
    await this.upsert(def);
  }

  /** @deprecated Use `remove(name)` instead. Kept for backward compatibility. */
  async cancel(name: string): Promise<void> {
    await this.remove(name);
  }

  // ──  Condition guard via shouldFire() hook ──────────────────────────────

  protected async shouldFire(
    def: ScheduleDefinition,
    _record: any,
  ): Promise<boolean> {
    if (def.condition) {
      try {
        const ctx = new ScheduleContext({
          id: "condition-check",
          scheduleName: def.name,
          firedAt: new Date(),
          payload: def.payload,
          logger: this.logger.child({
            schedule: def.name,
            context: "condition",
          }),
          signal: new AbortController().signal,
          environment: this.environment,
          project: this.project,
        });
        return await def.condition(ctx);
      } catch (err) {
        this.logger.error("Condition guard threw — skipping fire", {
          name: def.name,
          error: (err as Error).message,
        });
        return false;
      }
    }
    return true;
  }

  protected canTickRecord(def: ScheduleDefinition, record: any): boolean {
    if (!this.shardedLeader) return true;
    return (
      this.shardedLeader.isLeader &&
      this.shardedLeader.ownsJob(record.name ?? def.name)
    );
  }

  protected shouldFireWithoutNextRun(
    def: ScheduleDefinition,
    _record: any,
  ): boolean {
    return !!def.runAt;
  }

  protected createExecutionContext(opts: {
    def: ScheduleDefinition;
    runId: string;
    abort: AbortController;
    startedAt: Date;
    localLogs: Array<{ level: string; msg: string; ts: Date }>;
    localTimeline: Array<{
      ts: Date;
      from: string;
      to: string;
      reason: string;
    }>;
  }): any {
    return new ScheduleContext({
      id: opts.runId,
      logger: this.logger.child({ schedule: opts.def.name }),
      signal: opts.abort.signal,
      firedAt: opts.startedAt,
      scheduleName: opts.def.name,
      payload: opts.def.payload,
      environment: this.environment,
      project: this.project,
      onProgress: this.createOnProgress(
        opts.runId,
        opts.localLogs,
        opts.localTimeline,
      ),
      onLog: this.createOnLog(opts.def.name, opts.runId, opts.localLogs),
    });
  }
}
