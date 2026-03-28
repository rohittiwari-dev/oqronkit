import { randomUUID } from "node:crypto";
import { RRule, rrulestr } from "rrule";
import {
  createLogger,
  type IChronoAdapter,
  type IChronoModule,
  type ILockAdapter,
  type Logger,
  ScheduleContext,
  type ScheduleDefinition,
} from "../core/index.js";
import {
  HeartbeatWorker,
  LeaderElection,
  StallDetector,
} from "../lock/index.js";
import { _attachScheduleEngine } from "./define-schedule.js";

type ActiveJobEntry = {
  runId: string;
  lockKey: string;
  worker?: HeartbeatWorker;
  abort?: AbortController;
};

export class ScheduleEngine implements IChronoModule {
  public readonly name = "scheduler";
  public readonly enabled = true;

  private readonly nodeId: string;
  private readonly logger: Logger;
  private leader?: LeaderElection;
  private stallDetector: StallDetector;
  private tickTimer?: ReturnType<typeof setInterval>;

  private readonly activeJobs = new Map<string, ActiveJobEntry>();
  // Includes static instances and dynamically triggered instances
  private readonly schedules = new Map<string, ScheduleDefinition>();
  private _hasRunLeaderInit = false;

  constructor(
    staticSchedules: ScheduleDefinition[],
    private readonly db: IChronoAdapter,
    private readonly lock: ILockAdapter,
    logger?: Logger,
    private readonly environment?: string,
    private readonly project?: string,
    private readonly config?: {
      enable?: boolean;
      tickInterval?: number;
      keepJobHistory?: boolean | number;
      keepFailedJobHistory?: boolean | number;
    },
  ) {
    this.nodeId = randomUUID();
    this.logger =
      logger ?? createLogger({ level: "info" }, { module: "scheduler" });
    this.stallDetector = new StallDetector(this.lock, this.logger, 15_000);

    for (const def of staticSchedules) {
      this.schedules.set(def.name, def);
    }
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
    await this.db.upsertSchedule(def);
    const nextRun = this.computeNextRun(def, now);
    if (nextRun) {
      await this.db.updateNextRun(def.name, nextRun);
    }
  }

  /** Dynamically register and schedule a definition from trigger/schedule call */
  async registerDynamic(def: ScheduleDefinition): Promise<void> {
    this.schedules.set(def.name, def);
    await this.upsertAndSeed(def, new Date());
    this.logger.debug("Registered dynamic schedule", { name: def.name });
  }

  async cancel(name: string): Promise<void> {
    // We remove it from memory and from DB's execution queue by setting nextRunAt to null/distant past
    this.schedules.delete(name);
    // For now just removing it from tracking memory
  }

  async start(): Promise<void> {
    this.leader = new LeaderElection(
      this.lock,
      this.logger,
      "chrono:scheduleengine:leader",
      this.nodeId,
      30_000,
    );
    await this.leader.start();

    const interval = this.config?.tickInterval ?? 1_000;
    this.tickTimer = setInterval(() => {
      void this.tick();
    }, interval);

    this.logger.info("Schedule engine started", {
      nodeId: this.nodeId,
      interval,
    });
  }

  async stop(): Promise<void> {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.leader) await this.leader.stop();
    this.stallDetector.stop();
    for (const job of this.activeJobs.values()) {
      if (job.abort) job.abort.abort();
      if (job.worker) {
        await job.worker.stop();
      } else {
        await this.lock.release(job.lockKey, this.nodeId).catch(() => {});
      }
    }
    this.activeJobs.clear();
    this.logger.info("Schedule engine stopped");
  }

  // ── Core scheduling helpers ─────────────────────────────────────────────────

  private computeNextRun(def: ScheduleDefinition, from: Date): Date | null {
    try {
      if (def.runAt) {
        // If pure runAt and it's in the past, return it so it fires immediately.
        // In the fire method we will mark it as complete.
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
        // Basic handling of 'at'
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

  // ── Leader init (missed-fire recovery + stall detector) ─────────────────────

  private async handleLeaderInit(): Promise<void> {
    this.logger.info("Schedule Engine: Performing leader initialization...");

    // 2. Start stall detector to monitor node-local locks
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

  // ── Tick loop ───────────────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (!this.leader?.isLeader) return;

    if (!this._hasRunLeaderInit) {
      this._hasRunLeaderInit = true;
      await this.handleLeaderInit();
    }

    try {
      const now = new Date();
      const due = await this.db.getDueSchedules(now, 50);

      for (const { name } of due) {
        const def = this.schedules.get(name);

        // If not in static memory, check if it's dynamic but we don't have it loaded.
        // We will skip dynamic orphaned ones.
        if (!def) continue;

        // Condition Check
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
              // Push to next run time without actually firing
              const nextRun = this.computeNextRun(def, now);
              if (nextRun) await this.db.updateNextRun(def.name, nextRun);
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

        // CRITICAL: Compute and persist nextRunAt BEFORE firing.
        // If runAt, this is a one-time execution so nextRunAt becomes null.
        let nextRun: Date | null = null;
        if (!def.runAt && !def.runAfter) {
          nextRun = this.computeNextRun(def, now);
          if (!nextRun) {
            this.logger.error(
              "Cannot compute next run — suspending schedule to prevent runaway loop",
              { name: def.name },
            );
            await this.db.updateNextRun(def.name, null).catch(() => {});
            continue;
          }
        }

        // Next run is null for one-offs!
        await this.db.updateNextRun(def.name, nextRun);

        void this.fire(def);
      }
    } catch (err) {
      this.logger.error("Tick error", { err: String(err) });
    }
  }

  // ── Fire handler ────────────────────────────────────────────────────────────

  private async fire(def: ScheduleDefinition): Promise<void> {
    const isOverlapSkip = def.overlap === "skip" || def.overlap === false;

    // Local overlap check
    if (isOverlapSkip) {
      for (const job of this.activeJobs.values()) {
        if (job.lockKey === `chrono:schedule:run:${def.name}`) {
          this.logger.debug("Skipping overlapping run", { name: def.name });
          return;
        }
      }
    }

    const runId = randomUUID();
    const lockKey = isOverlapSkip
      ? `chrono:schedule:run:${def.name}`
      : `chrono:schedule:run:${def.name}:${runId}`;
    const startedAt = new Date();

    // ── Acquire lock ──────────────────────────────────────────────────────
    let worker: HeartbeatWorker | undefined;
    let acquired = false;

    if (def.guaranteedWorker) {
      worker = new HeartbeatWorker(
        this.lock,
        this.logger,
        lockKey,
        this.nodeId,
        def.lockTtlMs ?? 30_000,
        def.heartbeatMs ?? 10_000,
      );
      acquired = await worker.start();
    } else {
      acquired = await this.lock.acquire(
        lockKey,
        this.nodeId,
        def.lockTtlMs ?? 30_000,
      );
    }

    if (!acquired) return; // Cluster overlap protection

    const abort = new AbortController();
    this.activeJobs.set(runId, { runId, lockKey, worker, abort });

    await this.db.recordExecution({
      id: runId,
      scheduleId: def.name,
      status: "running",
      startedAt,
    });

    // ── Execute handler (non-blocking) ────────────────────────────────────
    void Promise.resolve().then(async () => {
      const ctx = new ScheduleContext({
        id: runId,
        logger: this.logger.child({ schedule: def.name }),
        signal: abort.signal,
        firedAt: startedAt,
        scheduleName: def.name,
        payload: def.payload,
        environment: this.environment,
        project: this.project,
        onProgress: (percent, label) => {
          this.db.updateJobProgress(runId, percent, label).catch((err) =>
            this.logger.error("Failed to update schedule progress", {
              runId,
              err,
            }),
          );
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
            // Race handler against timeout
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
            // Sleep without releasing lock
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

      const completedAt = new Date();
      await this.db.recordExecution({
        id: runId,
        scheduleId: def.name,
        status,
        startedAt,
        completedAt,
        error,
        result:
          finalResult !== undefined ? JSON.stringify(finalResult) : undefined,
        attempts,
        durationMs: completedAt.getTime() - startedAt.getTime(),
        ...(status === "completed"
          ? { progressPercent: 100, progressLabel: "Completed" }
          : {}),
      });

      if (worker) {
        await worker.stop();
      } else {
        await this.lock.release(lockKey, this.nodeId).catch(() => {});
      }

      this.activeJobs.delete(runId);

      // Handle history pruning based on configured cascade
      const keepJobHistory =
        def.keepHistory ?? this.config?.keepJobHistory ?? true;
      const keepFailedHistory =
        def.keepFailedHistory ?? this.config?.keepFailedJobHistory ?? true;

      if (keepJobHistory !== true || keepFailedHistory !== true) {
        this.db
          .pruneHistoryForSchedule(def.name, keepJobHistory, keepFailedHistory)
          .catch((err) =>
            this.logger.debug("Failed to prune history", {
              err,
              name: def.name,
            }),
          );
      }

      this.logger.info("Schedule finished", {
        name: def.name,
        runId,
        status,
        attempts,
      });
    });
  }
}
