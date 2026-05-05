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
  SchedulerMetrics,
  type SchedulerMetricsSnapshot,
  type ScheduleMetrics,
} from "./scheduler-metrics.js";
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
  STALL_GRACE_MS,
} from "./constants.js";

// ── Shared types ─────────────────────────────────────────────────────────────

export type ActiveJobEntry = {
  runId: string;
  lockKey: string;
  scheduleName: string;
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
    onError?: (
      ctx: any,
      err: Error,
    ) => Promise<boolean | void> | boolean | void;
  };
  keepHistory?: boolean | number;
  keepFailedHistory?: boolean | number;
  tags?: string[];
  disabledBehavior?: DisabledBehavior;
  status?: string;
  payload?: unknown;
  /**  Execution priority when multiple schedules fire simultaneously. Lower = higher priority. Default: 0. */
  priority?: number;
  /**  Random jitter in ms added to nextRunAt to prevent thundering herd. Default: 0. */
  jitterMs?: number;
  /**
   *  Optional rate limiter reference. When set, the tick loop calls
   * `rateLimiter.check({ name })` before firing. If blocked, the fire
   * is skipped and nextRunAt is advanced normally.
   */
  rateLimiter?: { check(ctx: any): Promise<{ allowed: boolean }> };
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
export abstract class BaseSchedulerEngine<TDef extends BaseDefinition>
  implements IOqronModule
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
      this.baseConfig?.lagMonitor?.sampleIntervalMs ??
        DEFAULT_LAG_SAMPLE_INTERVAL_MS,
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
  /** Storage namespace for schedule records (e.g. "cron_schedules", "schedule_schedules") — G1 fix */
  protected abstract readonly storageNamespace: string;

  /** Resolve a definition by name */
  protected abstract getDefinition(name: string): TDef | undefined;
  /** Add or replace a definition in the in-memory map (subclass-specific) */
  protected abstract setDefinition(name: string, def: TDef): void;
  /** Remove a definition from the in-memory map (subclass-specific) */
  protected abstract removeDefinition(name: string): void;
  /** Compute the next run date for a definition */
  protected abstract computeNextRun(def: TDef, from: Date): Date | null;
  /** Perform leader-init logic (missed-fire recovery, etc.) */
  protected abstract handleLeaderInit(): Promise<void>;
  /** Initialize definitions in storage on boot */
  abstract init(): Promise<void>;
  /** Validate a definition before upsert (e.g., cron expression validation). Override in subclass. */
  protected validateDefinition(_def: TDef): void {
    /* no-op by default */
  }
  /** Create the execution context for a handler invocation */
  protected abstract createExecutionContext(opts: {
    def: TDef;
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
  }): any;

  /**
   * Hook for subclasses to add pre-fire checks (e.g. condition guards).
   * Return false to skip firing this definition. Default: always fire.
   */
  protected async shouldFire(_def: TDef, _record: any): Promise<boolean> {
    return true;
  }

  protected canTickRecord(_def: TDef, _record: any): boolean {
    return true;
  }

  protected shouldFireWithoutNextRun(_def: TDef, _record: any): boolean {
    return false;
  }

  // ── Lifecycle (shared) ────────────────────────────────────────────────────

  async start(): Promise<void> {
    //  Idempotent — skip if already running
    if (this.tickTimer) return;

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
    this.metrics.start();
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
                  dbJob.stalledCount = (dbJob.stalledCount ?? 0) + 1;
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
                    this.logger.error("Failed to commit stall telemetry", {
                      runId: id,
                      error: String(e),
                    });
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
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
    if (this.leader) await this.leader.stop();
    this.stallDetector?.stop();
    this.lagMonitor.stop();
    this.metrics.stop();

    const activePromises = Array.from(this.activeJobs.values())
      .map((job) => job.promise)
      .filter((p): p is Promise<void> => p !== undefined);

    if (activePromises.length > 0) {
      this.logger.info(
        `${this.name} draining ${activePromises.length} active jobs...`,
      );
      const drainMs =
        this.baseConfig?.shutdownTimeout ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
      const drainTimeout = new Promise<void>((r) => {
        const h = setTimeout(r, drainMs);
        h.unref();
      });
      await Promise.race([Promise.allSettled(activePromises), drainTimeout]);
    }

    for (const job of this.activeJobs.values()) {
      if (job.abort) job.abort.abort();
      if (job.worker) {
        await job.worker.stop();
      } else {
        await this.di.lock.release(job.lockKey, this.nodeId).catch(() => {});
      }
    }
    this.activeJobs.clear();
    this.logger.info(`${this.name} engine stopped`);
  }

  async triggerManual(scheduleId: string): Promise<boolean> {
    const def = this.getDefinition(scheduleId);
    if (!def) return false;
    this.logger.info("Manual trigger requested", { scheduleId });
    if (this.leader && !this.leader.isLeader) {
      this.logger.warn(
        "Manual trigger skipped because this node is not leader",
        { scheduleId },
      );
      return true;
    }
    const record = (await this.di.storage.get<any>(
      this.storageNamespace,
      scheduleId,
    )) ?? { name: scheduleId, paused: def.status === "paused" };
    if (!this.canTickRecord(def, record)) {
      this.logger.warn(
        "Manual trigger skipped because this node does not own the schedule",
        { scheduleId },
      );
      return true;
    }
    if (record.paused) {
      this.logger.warn("Manual trigger skipped because schedule is paused", {
        scheduleId,
      });
      return true;
    }
    if (!(await this.shouldFire(def, record))) {
      this.logger.debug(
        "Manual trigger skipped because condition guard returned false",
        { scheduleId },
      );
      return true;
    }
    if (def.rateLimiter) {
      try {
        const result = await def.rateLimiter.check({ name: def.name });
        if (!result.allowed) {
          this.logger.debug(
            "Manual trigger skipped because rate limiter blocked it",
            { scheduleId },
          );
          return true;
        }
      } catch (err) {
        this.logger.warn(
          "Manual trigger rate limiter check failed - proceeding with fire",
          {
            scheduleId,
            err: String(err),
          },
        );
      }
    }
    void this.fire(def);
    return true;
  }

  async enable(): Promise<void> {
    this.enabled = true;
    if (!this.tickTimer) {
      await this.start();
    }
    OqronEventBus.emit("module:enabled", this.name);
  }

  async disable(): Promise<void> {
    this.enabled = false;
    //  Stop timers and monitors to avoid wasted CPU
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
    this.stallDetector?.stop();
    this.lagMonitor.stop();
    OqronEventBus.emit("module:disabled", this.name);
  }

  // ──  Cancel a running job by ID ──────────────────────────────────────

  async cancelActiveJob(jobId: string): Promise<boolean> {
    const entry = this.activeJobs.get(jobId);
    if (!entry) return false;

    entry.abort?.abort();
    if (entry.worker) {
      await entry.worker.stop();
    } else {
      await this.di.lock.release(entry.lockKey, this.nodeId).catch(() => {});
    }
    this.activeJobs.delete(jobId);

    // Persist cancelled status
    const job = await this.di.storage.get<any>("jobs", jobId);
    if (job) {
      await this.di.storage.save("jobs", jobId, {
        ...job,
        status: "cancelled",
        finishedAt: new Date(),
        timeline: [
          ...(job.timeline || []),
          {
            ts: new Date(),
            from: job.status,
            to: "cancelled",
            reason: "Cancelled via admin API",
          },
        ],
      });
    }

    OqronEventBus.emit("job:cancelled", this.queueName, jobId);
    this.logger.info("Active job cancelled", { jobId });
    return true;
  }

  // ── Metrics (G6) ─────────────────────────────────────────────────────────

  protected readonly metrics = new SchedulerMetrics();

  /** Get a full metrics snapshot for all tracked schedules in this engine. */
  getMetrics(): SchedulerMetricsSnapshot {
    return this.metrics.getMetrics();
  }

  /** Get metrics for a single schedule by name. */
  getMetricsForSchedule(name: string): ScheduleMetrics | undefined {
    return this.metrics.getMetricsForSchedule(name);
  }

  // ── Dynamic CRUD (G1) ───────────────────────────────────────────────────

  /**
   * Create or update a schedule definition at runtime.
   * If the schedule already exists, its config is updated and nextRunAt is recomputed.
   * If it's new, it's registered and seeded immediately.
   *
   * Emits `schedule:created` or `schedule:updated` on the EventBus.
   */
  async upsert(def: TDef): Promise<void> {
    // Validate (subclass may throw for invalid cron expressions etc.)
    this.validateDefinition(def);

    const existing = this.getDefinition(def.name);
    const isNew = !existing;

    // Update in-memory map
    this.setDefinition(def.name, def);

    // Persist to storage
    const now = new Date();
    const existingRecord = await this.di.storage.get<any>(
      this.storageNamespace,
      def.name,
    );

    const nextRun = this.computeNextRun(def, now);
    await this.di.storage.save(this.storageNamespace, def.name, {
      ...(existingRecord || {}),
      ...def,
      version: (def as any).version ?? existingRecord?.version ?? 0,
      nextRunAt: nextRun,
      lastRunAt: existingRecord?.lastRunAt,
      paused: existingRecord?.paused ?? (def as any).status === "paused",
      runCount: existingRecord?.runCount ?? 0,
      successCount: existingRecord?.successCount ?? 0,
      failCount: existingRecord?.failCount ?? 0,
      type: this.moduleType,
    });

    const eventType = this.moduleType as "cron" | "schedule";
    if (isNew) {
      OqronEventBus.emit("schedule:created", def.name, eventType);
      this.logger.info("Dynamic schedule created", {
        name: def.name,
        type: eventType,
      });
    } else {
      OqronEventBus.emit("schedule:updated", def.name, eventType);
      this.logger.info("Dynamic schedule updated", {
        name: def.name,
        type: eventType,
      });
    }
  }

  /**
   * Remove a schedule definition by name.
   * Stops future fires and cancels any active jobs for this schedule.
   *
   * Emits `schedule:deleted` on the EventBus.
   */
  async remove(name: string): Promise<void> {
    const existing = this.getDefinition(name);
    if (!existing) {
      this.logger.warn("Attempted to remove non-existent schedule", { name });
      return;
    }

    // Cancel any active jobs for this schedule
    for (const [runId, entry] of this.activeJobs.entries()) {
      if (entry.scheduleName === name) {
        entry.abort?.abort();
        if (entry.worker) {
          await entry.worker.stop();
        }
        this.activeJobs.delete(runId);
      }
    }

    // Remove from in-memory map and storage
    this.removeDefinition(name);
    await this.di.storage.delete(this.storageNamespace, name);

    const eventType = this.moduleType as "cron" | "schedule";
    OqronEventBus.emit("schedule:deleted", name, eventType);
    this.logger.info("Schedule removed", { name, type: eventType });
  }

  /**
   * Get the stored state of a schedule by name.
   * Returns the full persisted record including nextRunAt, runCount, etc.
   */
  async get(name: string): Promise<any | null> {
    return this.di.storage.get<any>(this.storageNamespace, name);
  }

  /**
   * List all schedule records in this engine's namespace.
   * Returns the full persisted state of each schedule.
   */
  async list(): Promise<any[]> {
    return this.di.storage.list<any>(this.storageNamespace);
  }

  // ── Per-Instance Pause/Resume API ─────────────────────────────────────────

  /**
   * Pause a specific schedule/cron instance by name.
   *
   * The instance's `paused` flag is persisted to storage. On the next tick,
   * the tick loop will see `record.paused === true` and apply the
   * `disabledBehavior` policy (hold/skip/reject).
   *
   * Emits `schedule:paused` on the EventBus.
   *
   * @example
   * ```ts
   * await cronEngine.pauseInstance("daily-report");
   * ```
   */
  async pauseInstance(name: string): Promise<void> {
    const record = await this.di.storage.get<any>(this.storageNamespace, name);
    if (!record) {
      this.logger.warn("Attempted to pause non-existent instance", { name });
      return;
    }
    if (record.paused) {
      this.logger.debug("Instance already paused", { name });
      return;
    }

    record.paused = true;
    record.pausedAt = new Date();
    await this.di.storage.save(this.storageNamespace, name, record);

    OqronEventBus.emit("schedule:paused", name);
    this.logger.info("Instance paused", { name, type: this.moduleType });
  }

  /**
   * Resume a previously paused schedule/cron instance by name.
   *
   * Clears the `paused` flag in storage. If held jobs exist (from
   * `disabledBehavior: "hold"`), they remain in storage and can be
   * replayed via `triggerManual()` or will be naturally picked up
   * if the definition's next fire is due.
   *
   * Emits `schedule:resumed` on the EventBus.
   *
   * @example
   * ```ts
   * await cronEngine.resumeInstance("daily-report");
   * ```
   */
  async resumeInstance(name: string): Promise<void> {
    const record = await this.di.storage.get<any>(this.storageNamespace, name);
    if (!record) {
      this.logger.warn("Attempted to resume non-existent instance", { name });
      return;
    }
    if (!record.paused) {
      this.logger.debug("Instance already active", { name });
      return;
    }

    record.paused = false;
    record.resumedAt = new Date();
    delete record.pausedAt;
    await this.di.storage.save(this.storageNamespace, name, record);

    OqronEventBus.emit("schedule:resumed", name);
    this.logger.info("Instance resumed", { name, type: this.moduleType });
  }

  /**
   * Check if a specific schedule/cron instance is currently paused.
   *
   * @returns `true` if paused, `false` if active or not found.
   */
  async isPaused(name: string): Promise<boolean> {
    const record = await this.di.storage.get<any>(this.storageNamespace, name);
    return record?.paused === true;
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
      //  Fetch only due schedules instead of scanning all
      const due = await this.di.storage.list<any>(
        this.storageNamespace,
        undefined,
        {
          where: [{ field: "nextRunAt", op: "$lte", value: now }],
        },
      );

      //  Sort due schedules by priority (lower number = higher priority)
      due.sort((a: any, b: any) => {
        const aPri = this.getDefinition(a.name)?.priority ?? 0;
        const bPri = this.getDefinition(b.name)?.priority ?? 0;
        return aPri - bPri;
      });

      for (const record of due) {
        const def = this.getDefinition(record.name);
        if (!def) continue;
        if (!this.canTickRecord(def, record)) continue;

        // ── Disabled behavior enforcement ──
        if (record.paused) {
          const behavior =
            def.disabledBehavior ?? this.baseConfig?.disabledBehavior ?? "hold";

          const nextRun = this.computeNextRun(def, now);
          await this.di.storage.save(this.storageNamespace, def.name, {
            ...record,
            nextRunAt: nextRun,
            lastRunAt: now,
            type: this.moduleType,
          });

          if (behavior === "skip") continue;

          if (behavior === "reject") {
            this.logger.warn(
              `${this.moduleType} fire rejected — instance is disabled`,
              {
                name: def.name,
                behavior: "reject",
              },
            );
            OqronEventBus.emit(
              "job:fail",
              this.moduleType,
              record.name,
              new Error(
                `${def.name} is disabled and configured to reject fires`,
              ),
            );
            continue;
          }

          // behavior === "hold"
          await this.createHeldJob(def, now);
          continue;
        }

        // CRITICAL: Advance pointer BEFORE firing
        //  Condition guard hook
        if (!(await this.shouldFire(def, record))) {
          this.logger.debug("Skipping fire — condition guard returned false", {
            name: def.name,
          });
          let guardNext = this.computeNextRun(def, now);
          if (guardNext && def.jitterMs && def.jitterMs > 0) {
            const jitter = Math.floor(Math.random() * def.jitterMs);
            guardNext = new Date(guardNext.getTime() + jitter);
          }
          await this.di.storage.save(this.storageNamespace, def.name, {
            ...record,
            nextRunAt: guardNext,
            lastRunAt: now,
            type: this.moduleType,
          });
          continue;
        }

        //  Per-schedule rate limiting
        if (def.rateLimiter) {
          try {
            const result = await def.rateLimiter.check({ name: def.name });
            if (!result.allowed) {
              this.logger.debug(`Rate limited — skipping fire`, {
                name: def.name,
              });
              // Still advance the pointer to prevent re-firing
              let rlNext = this.computeNextRun(def, now);
              if (rlNext && def.jitterMs && def.jitterMs > 0) {
                const jitter = Math.floor(Math.random() * def.jitterMs);
                rlNext = new Date(rlNext.getTime() + jitter);
              }
              await this.di.storage.save(this.storageNamespace, def.name, {
                ...record,
                nextRunAt: rlNext,
                lastRunAt: now,
                type: this.moduleType,
              });
              continue;
            }
          } catch (err) {
            this.logger.warn(
              "Rate limiter check failed — proceeding with fire",
              {
                name: def.name,
                err: String(err),
              },
            );
          }
        }

        let nextRun = this.computeNextRun(def, now);

        //  Apply jitter to prevent thundering herd
        if (nextRun && def.jitterMs && def.jitterMs > 0) {
          const jitter = Math.floor(Math.random() * def.jitterMs);
          nextRun = new Date(nextRun.getTime() + jitter);
        }
        if (!nextRun) {
          if (this.shouldFireWithoutNextRun(def, record)) {
            await this.di.storage.save(this.storageNamespace, def.name, {
              ...record,
              nextRunAt: null,
              lastRunAt: now,
              type: this.moduleType,
            });
            void this.fire(def, now);
            continue;
          }
          this.logger.error(
            "Cannot compute next run — suspending to prevent runaway loop",
            { name: def.name },
          );
          await this.di.storage.save(this.storageNamespace, def.name, {
            ...record,
            nextRunAt: null,
            type: this.moduleType,
          });
          continue;
        }

        //  Re-check leader status before critical pointer advance
        if (this.leader && !this.leader.isLeader) {
          this.logger.warn(
            "Leader demoted mid-tick — skipping pointer advance",
            {
              name: def.name,
            },
          );
          continue;
        }

        await this.di.storage.save(this.storageNamespace, def.name, {
          ...record,
          nextRunAt: nextRun,
          lastRunAt: now,
          type: this.moduleType,
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

    //  Count-first pruning — only fetch excess records instead of all held jobs
    const maxHeld = this.baseConfig?.maxHeldJobs ?? DEFAULT_MAX_HELD_JOBS;
    const heldFilter = {
      moduleName: def.name,
      status: "paused",
      pausedReason: "disabled-hold",
    };
    const heldCount = await this.di.storage.count("jobs", heldFilter);

    if (heldCount > maxHeld) {
      const excess = heldCount - maxHeld;
      const oldest = await this.di.storage.list<any>("jobs", heldFilter, {
        limit: excess,
      });
      for (const old of oldest) {
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
        undefined, // onHeartbeat — scheduler doesn't use broker claims
        // Bug #24: Abort scheduler handler when lock is lost
        () => {
          const entry = this.activeJobs.get(runId);
          if (entry?.abort && !entry.abort.signal.aborted) {
            this.logger.warn(
              `Lock lost for schedule run ${runId} — aborting handler`,
              {
                runId,
                lockKey,
                scheduleName: def.name,
              },
            );
            entry.abort.abort();
          }
        },
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
    const entry: ActiveJobEntry = {
      runId,
      lockKey,
      scheduleName: def.name,
      worker,
      abort,
    };
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
    OqronEventBus.emit(
      "schedule:fire:start",
      def.name,
      runId,
      this.moduleType as "cron" | "schedule",
    );
    entry.promise = this.executeHandler(
      def,
      runId,
      lockKey,
      startedAt,
      worker,
      abort,
    );
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
              reject(new Error(`Handler timed out after ${def.timeout}ms`));
            }, def.timeout);
          });
          finalResult = await Promise.race([def.handler(ctx), timeoutPromise]);
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
          await new Promise((resolve) => setTimeout(resolve, delay));
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
    const existingJob = (await this.di.storage.get<any>("jobs", runId)) ?? {};

    localTimeline.push({
      ts: finishedAt,
      from: "running",
      to: status,
      reason:
        status === "failed"
          ? (error ?? "Unknown error")
          : "Finished successfully",
    });

    const mergedTimeline = [...(existingJob.timeline || []), ...localTimeline];
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
      returnValue: finalResult !== undefined ? finalResult : undefined,
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
      await this.di.lock.release(lockKey, this.nodeId).catch(() => {});
    }

    this.activeJobs.delete(runId);

    // History pruning
    const keepHistory =
      def.keepHistory ?? this.baseConfig?.keepJobHistory ?? true;
    const keepFailed =
      def.keepFailedHistory ?? this.baseConfig?.keepFailedJobHistory ?? true;

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

    const durationMs = finishedAt.getTime() - startedAt.getTime();

    this.logger.info("Job finished", {
      name: def.name,
      runId,
      status,
      attempts,
      durationMs,
    });

    OqronEventBus.emit(
      "schedule:fire:complete",
      def.name,
      runId,
      status,
      durationMs,
    );

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

    // F2+ Enrich schedule record with aggregate counters and last-run info
    try {
      const schedRecord = await this.di.storage.get<any>(
        this.storageNamespace,
        def.name,
      );
      if (schedRecord) {
        await this.di.storage.save(this.storageNamespace, def.name, {
          ...schedRecord,
          runCount: (schedRecord.runCount ?? 0) + 1,
          successCount:
            (schedRecord.successCount ?? 0) + (status === "completed" ? 1 : 0),
          failCount:
            (schedRecord.failCount ?? 0) + (status === "failed" ? 1 : 0),
          lastStatus: status,
          lastDurationMs: finishedAt.getTime() - startedAt.getTime(),
          lastError: status === "failed" ? error : undefined,
          lastRunId: runId,
        });
      }
    } catch (enrichErr) {
      this.logger.warn("Failed to enrich schedule record", {
        name: def.name,
        error: (enrichErr as Error).message,
      });
    }
  }

  // ── Shared progress/log callback factory ──────────────────────────────────

  /** Creates the onProgress callback for context construction. */
  protected createOnProgress(
    runId: string,
    localLogs: Array<{ level: string; msg: string; ts: Date }>,
    localTimeline: Array<{
      ts: Date;
      from: string;
      to: string;
      reason: string;
    }>,
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
    const loggerMethods: Record<
      string,
      ((msg: string, meta?: Record<string, unknown>) => void) | undefined
    > = {
      trace: this.logger.trace?.bind(this.logger),
      debug: this.logger.debug?.bind(this.logger),
      info: this.logger.info?.bind(this.logger),
      warn: this.logger.warn?.bind(this.logger),
      error: this.logger.error?.bind(this.logger),
      fatal: this.logger.fatal?.bind(this.logger),
    };

    return (level, msg) => {
      loggerMethods[level]?.(`[${this.moduleType}:${defName}] ${msg}`, {
        runId,
      });
      localLogs.push({ level, msg, ts: new Date() });
    };
  }
}
