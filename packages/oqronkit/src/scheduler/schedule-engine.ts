import { randomUUID } from "node:crypto";
import { RRule, rrulestr } from "rrule";
import {
  createLogger,
  type DisabledBehavior,
  type IOqronModule,
  LagMonitor,
  type Logger,
  OqronContainer,
  OqronEventBus,
  ScheduleContext,
  type ScheduleDefinition,
} from "../engine/index.js";
import {
  HeartbeatWorker,
  LeaderElection,
  ShardedLeaderElection,
  StallDetector,
} from "../engine/lock/index.js";
import {
  keepHistoryToRemoveConfig,
  pruneAfterCompletion,
} from "../engine/utils/job-retention.js";
import { _attachScheduleEngine } from "./define-schedule.js";

type ActiveJobEntry = {
  runId: string;
  lockKey: string;
  worker?: HeartbeatWorker;
  abort?: AbortController;
  promise?: Promise<void>;
};

export class ScheduleEngine implements IOqronModule {
  public readonly name = "scheduler";
  public enabled = true;

  private readonly nodeId: string;
  private readonly logger: Logger;
  private leader?: LeaderElection;
  private shardedLeader?: ShardedLeaderElection;
  private stallDetector: StallDetector;
  private lagMonitor: LagMonitor;
  private tickTimer?: ReturnType<typeof setInterval>;

  private readonly activeJobs = new Map<string, ActiveJobEntry>();
  // Includes static instances and dynamically triggered instances
  private readonly schedules = new Map<string, ScheduleDefinition>();
  private _hasRunLeaderInit = false;

  constructor(
    staticSchedules: ScheduleDefinition[],
    logger?: Logger,
    private readonly environment?: string,
    private readonly project?: string,
    private readonly config?: {
      enable?: boolean;
      tickInterval?: number;
      keepJobHistory?: boolean | number;
      keepFailedJobHistory?: boolean | number;
      shutdownTimeout?: number;
      lagMonitor?: { maxLagMs?: number; sampleIntervalMs?: number };
      clustering?: {
        totalShards?: number;
        ownedShards?: number[];
        region?: string;
      };
      /**
       * Module-level default disabled behavior for all schedule definitions.
       * Individual definitions can override this.
       * @default "hold"
       */
      disabledBehavior?: DisabledBehavior;
      /**
       * Maximum held jobs per definition when disabledBehavior is "hold".
       * @default 100
       */
      maxHeldJobs?: number;
    },
    private readonly container?: OqronContainer,
  ) {
    this.nodeId = randomUUID();
    this.logger =
      logger ?? createLogger({ level: "info" }, { module: "scheduler" });
    this.stallDetector = new StallDetector(this.di.lock, this.logger, 15_000);
    this.lagMonitor = new LagMonitor(
      this.logger,
      this.config?.lagMonitor?.maxLagMs ?? 500,
      this.config?.lagMonitor?.sampleIntervalMs ?? 50,
    );

    for (const def of staticSchedules) {
      this.schedules.set(def.name, def);
    }
  }

  private get di(): OqronContainer {
    return this.container ?? OqronContainer.get();
  }

  /** Scoped key prefix for locks and leader election. */
  private get lockPrefix(): string {
    return `oqron:${this.project ?? "default"}:${this.environment ?? "development"}`;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

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
    await this.di.storage.save("schedules", def.name, def);
    const nextRun = this.computeNextRun(def, now);
    if (nextRun) {
      const existing =
        (await this.di.storage.get<any>("schedules", def.name)) || {};
      await this.di.storage.save("schedules", def.name, {
        ...existing,
        nextRunAt: nextRun,
      });
    }
  }

  /** Dynamically register and schedule a definition from trigger/schedule call */
  async registerDynamic(def: ScheduleDefinition): Promise<void> {
    this.schedules.set(def.name, def);
    await this.upsertAndSeed(def, new Date());
    this.logger.debug("Registered dynamic schedule", { name: def.name });
  }

  async cancel(name: string): Promise<void> {
    this.schedules.delete(name);
  }

  async start(): Promise<void> {
    const clustering = this.config?.clustering;

    if (clustering && (clustering.totalShards ?? 1) > 1) {
      // ── Sharded multi-region leader election ─────────────────────
      this.shardedLeader = new ShardedLeaderElection(
        this.di.lock,
        this.logger,
        `${this.lockPrefix}:scheduleengine:leader`,
        this.nodeId,
        clustering.totalShards!,
        clustering.ownedShards ?? [0],
        30_000,
      );
      await this.shardedLeader.start();
    } else {
      // ── Single-leader election (default) ──────────────────────────
      this.leader = new LeaderElection(
        this.di.lock,
        this.logger,
        `${this.lockPrefix}:scheduleengine:leader`,
        this.nodeId,
        30_000,
      );
      await this.leader.start();
    }

    const interval = this.config?.tickInterval ?? 1_000;
    this.tickTimer = setInterval(() => {
      void this.tick();
    }, interval);
    this.tickTimer.unref();

    this.logger.info("Schedule engine started", {
      nodeId: this.nodeId,
      interval,
      clustering: clustering
        ? {
            totalShards: clustering.totalShards,
            ownedShards: clustering.ownedShards,
          }
        : undefined,
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
            this.logger.error("Stalled schedule detected, aborting", {
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
                    this.logger.error(
                      "Failed to commit stall telemetry for schedule",
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
    if (this.shardedLeader) await this.shardedLeader.stop();
    this.stallDetector.stop();
    this.lagMonitor.stop();

    const activePromises = Array.from(this.activeJobs.values())
      .map((job) => job.promise)
      .filter((p): p is Promise<void> => p !== undefined);

    if (activePromises.length > 0) {
      this.logger.info(
        `Schedule Engine draining ${activePromises.length} active jobs...`,
      );
      const drainMs = this.config?.shutdownTimeout ?? 25_000;
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
    this.logger.info("Schedule engine stopped");
  }

  async triggerManual(scheduleId: string): Promise<boolean> {
    const def = this.schedules.get(scheduleId);
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

  // ── Core scheduling helpers ─────────────────────────────────────────────────

  private computeNextRun(def: ScheduleDefinition, from: Date): Date | null {
    try {
      if (def.runAt) {
        return new Date(def.runAt);
      }

      if (def.runAfter) {
        const add =
          (def.runAfter.days ?? 0) * 86400000 +
          (def.runAfter.hours ?? 0) * 3600000 +
          (def.runAfter.minutes ?? 0) * 60000 +
          (def.runAfter.seconds ?? 0) * 1000;
        return new Date(from.getTime() + add);
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
        const add =
          (def.every.hours ?? 0) * 3600000 +
          (def.every.minutes ?? 0) * 60000 +
          (def.every.seconds ?? 0) * 1000;
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

  private async handleLeaderInit(): Promise<void> {
    this.logger.info("Schedule Engine: Performing leader initialization...");

    // Note: StallDetector is already started in start() with abort-capable
    // callbacks. Do NOT re-initialize here — it would overwrite the abort
    // callback with a weaker log-only version, silently disabling crash recovery.

    // ── Missed-Fire Recovery ──────────────────────────────────────────────
    // Check if any recurring schedules missed their fire window during downtime.
    // One-shot schedules (runAt/runAfter) are skipped — they should only fire once.
    try {
      const allSchedules = await this.di.storage.list<any>("schedules");
      const now = new Date();

      for (const record of allSchedules) {
        const def = this.schedules.get(record.name);
        if (!def) continue;

        // Skip one-shot schedules — they are not recurring
        if (def.runAt || def.runAfter) continue;

        // If nextRunAt is in the past and the schedule isn't paused, it missed
        if (
          record.nextRunAt &&
          !record.paused &&
          new Date(record.nextRunAt) < now
        ) {
          this.logger.info("Triggering recovery for missed schedule", {
            name: def.name,
            missedAt: record.nextRunAt,
          });
          void this.fire(def);

          // Advance nextRunAt so we don't re-fire on the next tick
          const nextRun = this.computeNextRun(def, now);
          if (nextRun) {
            await this.di.storage.save("schedules", def.name, {
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

  private async tick(): Promise<void> {
    if (!this.enabled) return;

    // Check leadership: either single-leader or at least one shard
    const isLeader = this.shardedLeader
      ? this.shardedLeader.isLeader
      : this.leader?.isLeader;
    if (!isLeader) return;

    if (!this._hasRunLeaderInit) {
      this._hasRunLeaderInit = true;
      await this.handleLeaderInit();
    }

    try {
      if (this.lagMonitor.isCircuitTripped) {
        this.logger.debug("Tick skipped — event loop lag detected");
        return;
      }

      const now = new Date();
      const allSchedules = await this.di.storage.list<any>("schedules");
      const dueRecords = allSchedules
        .filter((s) => s.nextRunAt && new Date(s.nextRunAt) <= now)
        // If using sharded leader, only process schedules that hash to our owned shards
        .filter((s) =>
          this.shardedLeader ? this.shardedLeader.ownsJob(s.name) : true,
        );

      for (const record of dueRecords) {
        const def = this.schedules.get(record.name);
        if (!def) continue;

        // ── Disabled behavior enforcement ──────────────────────────────────
        if (record.paused) {
          const behavior =
            def.disabledBehavior ?? this.config?.disabledBehavior ?? "hold";

          // ALL disabled behaviors must advance the nextRunAt, otherwise we infinite-loop
          // every tick since the record stays in the past.
          const nextRun = this.computeNextRun(def, now);
          if (nextRun) {
            const existing =
              (await this.di.storage.get<any>("schedules", def.name)) || {};
            await this.di.storage.save("schedules", def.name, {
              ...existing,
              nextRunAt: nextRun,
              lastRunAt: now,
            });
          }

          if (behavior === "skip") {
            continue;
          }

          if (behavior === "reject") {
            this.logger.warn("Schedule fire rejected — instance is disabled", {
              name: def.name,
              behavior: "reject",
            });
            OqronEventBus.emit(
              "job:fail",
              "system_schedule",
              record.name,
              new Error(
                `Schedule ${def.name} is disabled and configured to reject fires`,
              ),
            );
            continue;
          }

          // behavior === "hold"
          const holdId = randomUUID();
          await this.di.storage.save("jobs", holdId, {
            id: holdId,
            type: "schedule",
            queueName: "system_schedule",
            moduleName: def.name,
            scheduleId: def.name,
            status: "paused",
            pausedReason: "disabled-hold",
            data: def.payload,
            opts: {},
            attemptMade: 0,
            progressPercent: 0,
            tags: def.tags ?? [],
            environment: this.environment ?? "default",
            project: this.project ?? "default",
            queuedAt: now,
            triggeredBy: "schedule",
            logs: [
              {
                level: "warn",
                msg: `Schedule ${def.name} fired while disabled — job held`,
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

          // Prune excess held jobs for this definition (FIFO — oldest removed first)
          const maxHeld = this.config?.maxHeldJobs ?? 100;
          const heldJobs = await this.di.storage.list<any>(
            "jobs",
            {
              moduleName: def.name,
              status: "paused",
              pausedReason: "disabled-hold",
            },
            { limit: 100_000 },
          );

          heldJobs.sort(
            (a: any, b: any) =>
              new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
          );

          if (heldJobs.length > maxHeld) {
            const toRemove = heldJobs.slice(0, heldJobs.length - maxHeld);
            for (const old of toRemove) {
              await this.di.storage.delete("jobs", old.id);
            }
          }

          this.logger.info("Schedule fire held — instance is disabled", {
            name: def.name,
            holdId,
          });
          continue;
        }

        if (def.condition) {
          try {
            const conditionVal = await def.condition(
              new ScheduleContext({
                id: "eval",
                scheduleName: def.name,
                firedAt: now,
                logger: this.logger,
                signal: new AbortController().signal,
                payload: def.payload,
                environment: this.environment,
                project: this.project,
              }),
            );
            if (!conditionVal) {
              const nextRun = this.computeNextRun(def, now);
              if (nextRun) {
                const existing =
                  (await this.di.storage.get<any>("schedules", def.name)) || {};
                await this.di.storage.save("schedules", def.name, {
                  ...existing,
                  nextRunAt: nextRun,
                });
              }
              continue;
            }
          } catch (e) {
            this.logger.error("Condition crashed", {
              name: def.name,
              error: String(e),
            });
            continue;
          }
        }

        let nextRun: Date | null = null;
        if (!def.runAt && !def.runAfter) {
          nextRun = this.computeNextRun(def, now);
          if (!nextRun) {
            this.logger.error(
              "Cannot compute next run — suspending schedule to prevent runaway loop",
              { name: def.name },
            );
            const existing =
              (await this.di.storage.get<any>("schedules", def.name)) || {};
            await this.di.storage.save("schedules", def.name, {
              ...existing,
              nextRunAt: null,
            });
            continue;
          }
        }

        const existing =
          (await this.di.storage.get<any>("schedules", def.name)) || {};
        await this.di.storage.save("schedules", def.name, {
          ...existing,
          nextRunAt: nextRun,
        });

        void this.fire(def);
      }
    } catch (err) {
      this.logger.error("Tick error", { err: String(err) });
    }
  }

  private async fire(def: ScheduleDefinition): Promise<void> {
    const isOverlapSkip = def.overlap === "skip" || def.overlap === false;

    if (isOverlapSkip) {
      for (const job of this.activeJobs.values()) {
        if (job.lockKey === `${this.lockPrefix}:schedule:run:${def.name}`) {
          this.logger.debug("Skipping overlapping run", { name: def.name });
          return;
        }
      }
    }

    if (def.maxConcurrent) {
      let activeCount = 0;
      for (const job of this.activeJobs.values()) {
        if (
          job.lockKey.startsWith(`${this.lockPrefix}:schedule:run:${def.name}`)
        )
          activeCount++;
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
      ? `${this.lockPrefix}:schedule:run:${def.name}`
      : `${this.lockPrefix}:schedule:run:${def.name}:${runId}`;
    const startedAt = new Date();

    let worker: HeartbeatWorker | undefined;
    let acquired = false;

    if (def.guaranteedWorker) {
      worker = new HeartbeatWorker(
        this.di.lock,
        this.logger,
        lockKey,
        this.nodeId,
        def.lockTtlMs ?? 30_000,
        def.heartbeatMs ?? 10_000,
      );
      acquired = await worker.start();
    } else {
      acquired = await this.di.lock.acquire(
        lockKey,
        this.nodeId,
        def.lockTtlMs ?? 30_000,
      );
    }
    if (!acquired) return;

    const abort = new AbortController();
    const entry: ActiveJobEntry = { runId, lockKey, worker, abort };
    this.activeJobs.set(runId, entry);

    // Persist running job state
    await this.di.storage.save("jobs", runId, {
      id: runId,
      type: "schedule",
      queueName: "system_schedule",
      moduleName: def.name,
      status: "running",
      data: def.payload,
      opts: {},
      attemptMade: 1,
      progressPercent: 0,
      tags: [],
      scheduleId: def.name,
      environment: this.environment ?? "default",
      project: this.project ?? "default",
      createdAt: startedAt,
      queuedAt: startedAt,
      triggeredBy: "schedule",
      logs: [],
      timeline: [
        {
          ts: startedAt,
          from: "waiting",
          to: "running",
          reason: `Schedule ${def.name} fired`,
        },
      ],
      steps: [],
      startedAt,
    });

    OqronEventBus.emit("job:start", "system_schedule", runId, def.name);
    entry.promise = Promise.resolve().then(async () => {
      // Local accumulator — guarantees no log entries are lost to async races
      const localLogs: Array<{ level: string; msg: string; ts: Date }> = [];
      const localTimeline: Array<{
        ts: Date;
        from: string;
        to: string;
        reason: string;
      }> = [];

      const ctx = new ScheduleContext({
        id: runId,
        logger: this.logger.child({ schedule: def.name }),
        signal: abort.signal,
        firedAt: startedAt,
        scheduleName: def.name,
        payload: def.payload,
        environment: this.environment,
        project: this.project,
        onProgress: async (percent, label) => {
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
            }
          } catch (err) {
            this.logger.error("Failed to update schedule progress", {
              runId,
              err,
            });
          }
        },
        onLog: (level, msg) => {
          // Synchronous push — no async race, no lost logs
          (this.logger as any)[level]?.(`[Schedule:${def.name}] ${msg}`, {
            runId,
          });
          localLogs.push({ level, msg, ts: new Date() });
        },
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
          break; // Success!
        } catch (err: unknown) {
          error = err instanceof Error ? err.message : String(err);
          status = "failed";

          if (def.hooks?.onError && err instanceof Error) {
            try {
              await Promise.resolve(def.hooks.onError(ctx, err));
            } catch (e) {
              this.logger.error("onError hook threw", { err: String(e) });
            }
          }

          if (attempts < maxAttempts) {
            this.logger.warn("Schedule handler threw, retrying...", {
              name: def.name,
              runId,
              attempt: attempts,
              error,
            });

            const baseDelay = def.retries?.baseDelay ?? 2000;
            const delay =
              def.retries?.strategy === "exponential"
                ? baseDelay * 2 ** (attempts - 1)
                : baseDelay;

            attempts++;
            await new Promise((resolve) => setTimeout(resolve, delay));
          } else {
            this.logger.error("Schedule handler failed completely", {
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

      const finishedAt = new Date();
      const existingJob = (await this.di.storage.get<any>("jobs", runId)) ?? {};

      // Push the final completion event into local accumulator
      localTimeline.push({
        ts: finishedAt,
        from: "running",
        to: status,
        reason:
          status === "failed"
            ? (error ?? "Unknown error")
            : "Finished successfully",
      });

      // Merge: initial timeline from DB + all locally accumulated entries
      const mergedTimeline = [
        ...(existingJob.timeline || []),
        ...localTimeline,
      ];
      // Merge: initial logs from DB + all locally accumulated entries
      const mergedLogs = [...(existingJob.logs || []), ...localLogs];

      await this.di.storage.save("jobs", runId, {
        ...existingJob,
        id: runId,
        type: "schedule",
        queueName: "system_schedule",
        moduleName: def.name,
        status,
        data: def.payload,
        opts: {},
        attemptMade: attempts,
        progressPercent: status === "completed" ? 100 : 0,
        progressLabel: status === "completed" ? "Completed" : "Failed",
        tags: def.tags ?? [],
        scheduleId: def.name,
        workerId: this.nodeId,
        environment: this.environment ?? "default",
        project: this.project ?? "default",
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        error,
        stacktrace: error && status === "failed" ? [error] : undefined,
        returnValue: finalResult !== undefined ? finalResult : undefined,
        createdAt: startedAt,
        queuedAt: existingJob.queuedAt ?? startedAt,
        startedAt,
        processedOn: startedAt,
        finishedAt,
        logs: mergedLogs,
        timeline: mergedTimeline,
      });

      if (worker) {
        await worker.stop();
      } else {
        await this.di.lock.release(lockKey, this.nodeId).catch(() => {});
      }
      this.activeJobs.delete(runId);

      // History pruning via shared utility
      const keepHistory =
        def.keepHistory ?? this.config?.keepJobHistory ?? true;
      const keepFailed =
        def.keepFailedHistory ?? this.config?.keepFailedJobHistory ?? true;

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

      this.logger.info("Schedule finished", {
        name: def.name,
        runId,
        status,
        attempts,
      });

      if (status === "completed") {
        OqronEventBus.emit("job:success", "system_schedule", runId);
      } else {
        OqronEventBus.emit(
          "job:fail",
          "system_schedule",
          runId,
          new Error(error ?? "Unknown error"),
        );
      }
    });
  }
}
