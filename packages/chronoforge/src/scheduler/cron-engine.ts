import { randomUUID } from "node:crypto";
import {
  CronContext,
  type CronDefinition,
  createLogger,
  type IChronoAdapter,
  type IChronoModule,
  type ILockAdapter,
  type Logger,
} from "../core/index.js";
import {
  HeartbeatWorker,
  LeaderElection,
  StallDetector,
} from "../lock/index.js";
import { getNextRunDate } from "./expression-parser.js";
import { MissedFireHandler } from "./missed-fire.handler.js";

type ActiveJobEntry = {
  runId: string;
  lockKey: string;
  worker?: HeartbeatWorker;
  abort?: AbortController;
};

export class SchedulerModule implements IChronoModule {
  public readonly name = "cron";
  public readonly enabled = true;

  private readonly nodeId: string;
  private readonly logger: Logger;
  private leader?: LeaderElection;
  private stallDetector: StallDetector;
  private missedFireHandler: MissedFireHandler;
  private tickTimer?: ReturnType<typeof setInterval>;

  private readonly activeJobs = new Map<string, ActiveJobEntry>();
  private _hasRunLeaderInit = false;

  constructor(
    private readonly schedules: CronDefinition[],
    private readonly db: IChronoAdapter,
    private readonly lock: ILockAdapter,
    logger?: Logger,
    private readonly environment?: string,
    private readonly project?: string,
    private readonly config?: {
      enable?: boolean;
      timezone?: string;
      tickInterval?: number;
      missedFirePolicy?: "skip" | "run-once" | "run-all";
      maxConcurrentJobs?: number;
      leaderElection?: boolean;
    },
  ) {
    this.nodeId = randomUUID();
    this.logger =
      logger ?? createLogger({ level: "info" }, { module: "scheduler" });
    this.stallDetector = new StallDetector(this.lock, this.logger, 15_000);
    this.missedFireHandler = new MissedFireHandler(this.logger, this.db);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    this.logger.info("Initializing scheduler", {
      nodeId: this.nodeId,
      count: this.schedules.length,
    });

    for (const def of this.schedules) {
      await this.db.upsertSchedule(def);
      this.logger.debug("Registered schedule", {
        name: def.name,
        expression: def.expression,
        intervalMs: def.intervalMs,
      });
    }

    // ── CRITICAL: Seed nextRunAt for schedules that don't have one yet ──
    const existing = await this.db.getSchedules();
    const now = new Date();

    for (const record of existing) {
      if (record.nextRunAt !== null) continue;

      const def = this.schedules.find((s) => s.name === record.name);
      if (!def) continue;

      const nextRun = this.computeNextRun(def, now);
      if (nextRun) {
        await this.db.updateNextRun(def.name, nextRun);
        this.logger.debug("Seeded nextRunAt", {
          name: def.name,
          nextRunAt: nextRun.toISOString(),
        });
      }
    }
  }

  async start(): Promise<void> {
    // leaderElection defaults to true in schema if not provided
    if (this.config?.leaderElection !== false) {
      this.leader = new LeaderElection(
        this.lock,
        this.logger,
        "chrono:scheduler:leader",
        this.nodeId,
        30_000,
      );
      await this.leader.start();
    }

    const interval = this.config?.tickInterval ?? 1_000;
    this.tickTimer = setInterval(() => {
      void this.tick();
    }, interval);

    this.logger.info("Scheduler started", { nodeId: this.nodeId, interval });
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
    this.logger.info("Scheduler stopped");
  }

  // ── Core scheduling helpers ─────────────────────────────────────────────────

  /**
   * Compute the next fire time for a definition.
   * Returns null if computation fails (invalid expression, etc).
   */
  private computeNextRun(def: CronDefinition, from: Date): Date | null {
    if (def.expression) {
      try {
        const timezone = def.timezone ?? this.config?.timezone;
        return getNextRunDate(def.expression, timezone, from);
      } catch (err) {
        this.logger.error("Failed to compute next run from expression", {
          name: def.name,
          expression: def.expression,
          err: String(err),
        });
        return null;
      }
    }

    if (def.intervalMs) {
      return new Date(from.getTime() + def.intervalMs);
    }

    this.logger.error("Schedule has neither expression nor intervalMs", {
      name: def.name,
    });
    return null;
  }

  // ── Leader init (missed-fire recovery + stall detector) ─────────────────────

  private async handleLeaderInit(): Promise<void> {
    this.logger.info("Performing leader initialization...");

    // 1. Evaluate missed fires
    const knownSchedules = await this.db.getSchedules();
    const now = new Date();

    for (const record of knownSchedules) {
      const def = this.schedules.find((s) => s.name === record.name);
      if (!def) continue;

      const missed = await this.missedFireHandler.checkMissed(
        def,
        record.lastRunAt,
        now,
      );
      if (missed) {
        this.logger.info("Triggering recovery run for missed schedule", {
          name: def.name,
        });
        void this.fire(def);
      }
    }

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

  private async detectClusterStalls() {
    try {
      const activeDbJobs = await this.db.getActiveJobs();
      for (const job of activeDbJobs) {
        if (!job.scheduleId) continue;
        const def = this.schedules.find((s) => s.name === job.scheduleId);
        if (!def?.guaranteedWorker) continue;

        const ageMs = Date.now() - job.startedAt.getTime();
        const ttl = def.lockTtlMs ?? 50_000;

        if (ageMs > ttl + 10_000) {
          this.logger.warn("Cluster stall detected", { runId: job.id });
          await this.db.recordExecution({
            id: job.id,
            scheduleId: job.scheduleId,
            status: "failed",
            error: "Stall detected (lock assumed expired)",
            startedAt: job.startedAt,
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

  // ── Tick loop ───────────────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    // If leader election is disabled, we always run as "leader"
    if (this.leader && !this.leader.isLeader) return;

    if (!this._hasRunLeaderInit) {
      this._hasRunLeaderInit = true;
      await this.handleLeaderInit();
    }

    try {
      // 1. Cluster stall check (~10% probability per tick)
      if (Math.random() < 0.1) {
        void this.detectClusterStalls();
      }

      // 2. Fire due schedules
      const now = new Date();
      const due = await this.db.getDueSchedules(now, 50);

      for (const { name } of due) {
        const def = this.schedules.find((s) => s.name === name);
        if (!def) continue;

        // CRITICAL: Compute and persist nextRunAt BEFORE firing.
        const nextRun = this.computeNextRun(def, now);
        if (!nextRun) {
          this.logger.error(
            "Cannot compute next run — skipping fire to prevent runaway loop",
            { name: def.name },
          );
          continue;
        }
        await this.db.updateNextRun(def.name, nextRun);

        void this.fire(def);
      }
    } catch (err) {
      this.logger.error("Tick error", { err: String(err) });
    }
  }

  // ── Fire handler ────────────────────────────────────────────────────────────

  private async fire(def: CronDefinition): Promise<void> {
    const isOverlapSkip = def.overlap === "skip" || def.overlap === false;

    // Local overlap check
    if (isOverlapSkip) {
      for (const job of this.activeJobs.values()) {
        if (job.lockKey === `chrono:run:${def.name}`) {
          this.logger.debug("Skipping overlapping run", { name: def.name });
          return;
        }
      }
    }

    const runId = randomUUID();
    const lockKey = isOverlapSkip
      ? `chrono:run:${def.name}`
      : `chrono:run:${def.name}:${runId}`;
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
      const ctx = new CronContext({
        id: runId,
        logger: this.logger.child({ schedule: def.name }),
        signal: abort.signal,
        firedAt: startedAt,
        scheduleName: def.name,
        environment: this.environment,
        project: this.project,
        onProgress: (percent, label) => {
          this.db
            .updateJobProgress(runId, percent, label)
            .catch((err) =>
              this.logger.error("Failed to update progress", { runId, err }),
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
            this.logger.warn("Job handler threw, retrying...", {
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
            this.logger.error("Job handler failed completely", {
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

      // Update nextRunAt after completion
      if (def.intervalMs) {
        const nextRun = this.computeNextRun(def, new Date());
        if (nextRun) {
          await this.db.updateNextRun(def.name, nextRun).catch(() => {});
        }
      }

      this.logger.info("Job finished", {
        name: def.name,
        runId,
        status,
        attempts,
      });
    });
  }
}
