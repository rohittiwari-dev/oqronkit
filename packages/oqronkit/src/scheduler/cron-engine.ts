import { randomUUID } from "node:crypto";
import {
  CronContext,
  type CronDefinition,
  createLogger,
  type IOqronModule,
  LagMonitor,
  Lock,
  type Logger,
  OqronEventBus,
  Storage,
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
import { getNextRunDate } from "./expression-parser.js";
import { MissedFireHandler } from "./missed-fire.handler.js";

type ActiveJobEntry = {
  runId: string;
  lockKey: string;
  worker?: HeartbeatWorker;
  abort?: AbortController;
  promise?: Promise<void>;
};

export class SchedulerModule implements IOqronModule {
  public readonly name = "cron";
  public readonly enabled = true;

  private readonly nodeId: string;
  private readonly logger: Logger;
  private leader?: LeaderElection;
  private stallDetector: StallDetector;
  private lagMonitor: LagMonitor;
  private missedFireHandler: MissedFireHandler;
  private tickTimer?: ReturnType<typeof setInterval>;

  private readonly activeJobs = new Map<string, ActiveJobEntry>();
  private _hasRunLeaderInit = false;

  constructor(
    private readonly schedules: CronDefinition[],
    logger?: Logger,
    private readonly environment?: string,
    private readonly project?: string,
    private readonly config?: {
      enable?: boolean;
      timezone?: string;
      tickInterval?: number;
      leaderElection?: boolean;
      keepJobHistory?: boolean | number;
      keepFailedJobHistory?: boolean | number;
      shutdownTimeout?: number;
      lagMonitor?: { maxLagMs?: number; sampleIntervalMs?: number };
    },
  ) {
    this.nodeId = randomUUID();
    this.logger =
      logger ?? createLogger({ level: "info" }, { module: "scheduler" });
    this.stallDetector = new StallDetector(Lock, this.logger, 15_000);
    this.lagMonitor = new LagMonitor(
      this.logger,
      this.config?.lagMonitor?.maxLagMs ?? 500,
      this.config?.lagMonitor?.sampleIntervalMs ?? 50,
    );
    this.missedFireHandler = new MissedFireHandler(this.logger);
  }

  /** Scoped key prefix for locks and leader election. */
  private get lockPrefix(): string {
    return `oqron:${this.project ?? "default"}:${this.environment ?? "development"}`;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    this.logger.info("Initializing scheduler (Unified Model)", {
      nodeId: this.nodeId,
      count: this.schedules.length,
    });

    for (const def of this.schedules) {
      await Storage.save("schedules", def.name, def);
    }

    // Seed initial nextRunAt
    const existing = await Storage.list<any>("schedules");
    const now = new Date();

    for (const record of existing) {
      if (record.nextRunAt !== null && record.nextRunAt !== undefined) continue;

      const def = this.schedules.find((s) => s.name === record.name);
      if (!def) continue;

      const nextRun = this.computeNextRun(def, now);
      if (nextRun) {
        await Storage.save("schedules", def.name, {
          ...record,
          nextRunAt: nextRun,
        });
      }
    }
  }

  async start(): Promise<void> {
    // leaderElection defaults to true in schema if not provided
    if (this.config?.leaderElection !== false) {
      this.leader = new LeaderElection(
        Lock,
        this.logger,
        `${this.lockPrefix}:scheduler:leader`,
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
    this.stallDetector.stop();
    this.lagMonitor.stop();

    const activePromises = Array.from(this.activeJobs.values())
      .map((job) => job.promise)
      .filter((p): p is Promise<void> => p !== undefined);

    if (activePromises.length > 0) {
      this.logger.info(
        `Scheduler draining ${activePromises.length} active jobs...`,
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
        await Lock.release(job.lockKey, this.nodeId).catch(() => {});
      }
    }
    this.activeJobs.clear();
    this.logger.info("Scheduler stopped");
  }

  async triggerManual(scheduleId: string): Promise<boolean> {
    const def = this.schedules.find((s) => s.name === scheduleId);
    if (!def) return false;
    this.logger.info("Manual trigger requested", { scheduleId });
    void this.fire(def);
    return true;
  }

  // ── Core scheduling helpers ─────────────────────────────────────────────────

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

    return null;
  }

  // ── Leader init (missed-fire recovery + stall detector) ─────────────────────

  private async handleLeaderInit(): Promise<void> {
    this.logger.info("Performing leader initialization...");

    // 1. Evaluate missed fires
    const knownSchedules = await Storage.list<any>("schedules");
    const now = new Date();

    for (const record of knownSchedules) {
      const def = this.schedules.find((s) => s.name === record.name);
      if (!def) continue;

      const missed = await this.missedFireHandler.checkMissed(
        def,
        record.lastRunAt ? new Date(record.lastRunAt) : null,
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
      const activeDbJobs = await Storage.list<any>("cron_history", {
        status: "running",
      });
      for (const job of activeDbJobs) {
        if (!job.scheduleId) continue;
        const def = this.schedules.find((s) => s.name === job.scheduleId);
        if (!def?.guaranteedWorker) continue;

        const ageMs = Date.now() - new Date(job.startedAt).getTime();
        const ttl = def.lockTtlMs ?? 50_000;

        if (ageMs > ttl + 10_000) {
          this.logger.warn("Cluster stall detected", { runId: job.id });
          await Storage.save("cron_history", job.id, {
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

  // ── Tick loop ───────────────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    // If leader election is disabled, we always run as "leader"
    if (this.leader && !this.leader.isLeader) return;

    if (!this._hasRunLeaderInit) {
      this._hasRunLeaderInit = true;
      await this.handleLeaderInit();
    }

    try {
      // 0. Circuit Breaker: Skip if event loop is stalled
      if (this.lagMonitor.isCircuitTripped) {
        this.logger.debug("Tick skipped — event loop lag detected");
        return;
      }

      // 1. Cluster stall check (~10% probability per tick)
      if (Math.random() < 0.1) {
        void this.detectClusterStalls();
      }

      // 2. Fire due schedules
      const now = new Date();
      const allSchedules = await Storage.list<any>("schedules");

      const due = allSchedules.filter(
        (s: any) => s.nextRunAt && new Date(s.nextRunAt) <= now && !s.paused,
      );

      for (const record of due) {
        const def = this.schedules.find((s) => s.name === record.name);
        if (!def) continue;

        // CRITICAL: Compute and persist nextRunAt BEFORE firing.
        const nextRun = this.computeNextRun(def, now);
        if (!nextRun) {
          this.logger.error(
            "Cannot compute next run — suspending cron to prevent runaway loop",
            { name: def.name },
          );
          await Storage.save("schedules", def.name, {
            ...record,
            nextRunAt: null,
          });
          continue;
        }

        await Storage.save("schedules", def.name, {
          ...record,
          nextRunAt: nextRun,
          lastRunAt: now,
        });

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
        if (job.lockKey === `${this.lockPrefix}:run:${def.name}`) {
          this.logger.debug("Skipping overlapping run", { name: def.name });
          return;
        }
      }
    }

    // Concurrency rate limiting
    if (def.maxConcurrent) {
      let activeCount = 0;
      for (const job of this.activeJobs.values()) {
        if (job.lockKey.startsWith(`${this.lockPrefix}:run:${def.name}`))
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
      ? `${this.lockPrefix}:run:${def.name}`
      : `${this.lockPrefix}:run:${def.name}:${runId}`;
    const startedAt = new Date();

    // ── Acquire lock ──────────────────────────────────────────────────────
    let worker: HeartbeatWorker | undefined;
    let acquired = false;

    if (def.guaranteedWorker) {
      worker = new HeartbeatWorker(
        Lock,
        this.logger,
        lockKey,
        this.nodeId,
        def.lockTtlMs ?? 30_000,
        def.heartbeatMs ?? 10_000,
      );
      acquired = await worker.start();
    } else {
      acquired = await Lock.acquire(
        lockKey,
        this.nodeId,
        def.lockTtlMs ?? 30_000,
      );
    }

    if (!acquired) return; // Cluster overlap protection

    const abort = new AbortController();
    const entry: ActiveJobEntry = { runId, lockKey, worker, abort };
    this.activeJobs.set(runId, entry);

    await Storage.save("cron_history", runId, {
      id: runId,
      type: "cron",
      queueName: "system_cron",
      scheduleId: def.name,
      status: "active",
      data: null,
      opts: {},
      attemptMade: 0,
      progressPercent: 0,
      workerId: this.nodeId,
      tags: def.tags ?? [],
      environment: this.environment,
      project: this.project,
      createdAt: startedAt,
      startedAt,
    });

    // ── Execute handler (non-blocking) ────────────────────────────────────
    OqronEventBus.emit("job:start", "cron", runId, def.name);
    entry.promise = Promise.resolve().then(async () => {
      const ctx = new CronContext({
        id: runId,
        logger: this.logger.child({ schedule: def.name }),
        signal: abort.signal,
        firedAt: startedAt,
        scheduleName: def.name,
        environment: this.environment,
        project: this.project,
        onProgress: async (percent, label) => {
          try {
            const job = await Storage.get<any>("cron_history", runId);
            if (job) {
              await Storage.save("cron_history", runId, {
                ...job,
                progressPercent: percent,
                progressLabel: label,
              });
            }
          } catch (err) {
            this.logger.error("Failed to update progress", { runId, err });
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

      const finishedAt = new Date();
      await Storage.save("cron_history", runId, {
        id: runId,
        type: "cron",
        queueName: "system_cron",
        scheduleId: def.name,
        status,
        data: null,
        opts: {},
        attemptMade: attempts,
        progressPercent: status === "completed" ? 100 : 0,
        progressLabel: status === "completed" ? "Completed" : undefined,
        workerId: this.nodeId,
        tags: def.tags ?? [],
        environment: this.environment,
        project: this.project,
        returnValue: finalResult !== undefined ? finalResult : undefined,
        error,
        stacktrace: error && status === "failed" ? [error] : undefined,
        createdAt: startedAt,
        startedAt,
        finishedAt,
      });

      if (worker) {
        await worker.stop();
      } else {
        await Lock.release(lockKey, this.nodeId).catch(() => {});
      }

      this.activeJobs.delete(runId);

      // Update nextRunAt after completion
      if (def.intervalMs) {
        const nextRun = this.computeNextRun(def, new Date());
        if (nextRun) {
          const record = await Storage.get<any>("schedules", def.name);
          if (record) {
            await Storage.save("schedules", def.name, {
              ...record,
              nextRunAt: nextRun,
            });
          }
        }
      }

      // History pruning via shared utility
      const keepHistory =
        def.keepHistory ?? this.config?.keepJobHistory ?? true;
      const keepFailed =
        def.keepFailedHistory ?? this.config?.keepFailedJobHistory ?? true;

      await pruneAfterCompletion({
        namespace: "cron_history",
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
        OqronEventBus.emit("job:success", "cron", runId);
      } else {
        OqronEventBus.emit(
          "job:fail",
          "cron",
          runId,
          new Error(error ?? "Unknown error"),
        );
      }
    });
  }
}
