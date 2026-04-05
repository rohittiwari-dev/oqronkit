import { randomUUID } from "node:crypto";
import { RRule, rrulestr } from "rrule";
import {
  createLogger,
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
  public readonly enabled = true;

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
            job.abort?.abort();
            this.activeJobs.delete(id);
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
      const drainTimeout = new Promise<void>((r) => setTimeout(r, drainMs));
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
    this.stallDetector.start(
      () => {
        return Array.from(this.activeJobs.values())
          .filter((job) => job.worker !== undefined)
          .map((job) => ({
            key: job.lockKey,
            ownerId: this.nodeId,
          }));
      },
      (key: string) => {
        this.logger.warn("Local stall detected", { key });
      },
    );
  }

  private async tick(): Promise<void> {
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
      const due = allSchedules
        .filter((s) => s.nextRunAt && new Date(s.nextRunAt) <= now && !s.paused)
        .map((s) => s.name)
        // If using sharded leader, only process schedules that hash to our owned shards
        .filter((name) =>
          this.shardedLeader ? this.shardedLeader.ownsJob(name) : true,
        );

      for (const name of due) {
        const def = this.schedules.get(name);
        if (!def) continue;

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
    await this.di.storage.save("schedule_history", runId, {
      id: runId,
      type: "schedule",
      queueName: "system_schedule",
      status: "running" as any,
      data: def.payload,
      opts: {},
      attemptMade: 1,
      progressPercent: 0,
      tags: [],
      scheduleId: def.name,
      createdAt: startedAt,
      startedAt,
    });

    OqronEventBus.emit("job:start", "system_schedule", runId, def.name);
    entry.promise = Promise.resolve().then(async () => {
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
            const job = await this.di.storage.get<any>(
              "schedule_history",
              runId,
            );
            if (job) {
              await this.di.storage.save("schedule_history", runId, {
                ...job,
                progressPercent: percent,
                progressLabel: label,
              });
            }
          } catch (err) {
            this.logger.error("Failed to update schedule progress", {
              runId,
              err,
            });
          }
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
      await this.di.storage.save("schedule_history", runId, {
        id: runId,
        type: "schedule",
        queueName: "system_schedule",
        status: status as any,
        data: def.payload,
        opts: {},
        attemptMade: attempts,
        progressPercent: status === "completed" ? 100 : 0,
        progressLabel: status === "completed" ? "Completed" : "Failed",
        tags: def.tags ?? [],
        scheduleId: def.name,
        workerId: this.nodeId,
        environment: this.environment,
        project: this.project,
        error,
        stacktrace: error && status === "failed" ? [error] : undefined,
        returnValue: finalResult !== undefined ? finalResult : undefined,
        createdAt: startedAt,
        startedAt,
        finishedAt,
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
        namespace: "schedule_history",
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
