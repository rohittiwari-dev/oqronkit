import { randomUUID } from "node:crypto";
import {
  CronContext,
  type CronDefinition,
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
  public enabled = true;

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
      /**
       * Module-level default disabled behavior for all cron definitions.
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
    this.missedFireHandler = new MissedFireHandler(this.logger);
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
    this.logger.info("Initializing scheduler (Unified Model)", {
      nodeId: this.nodeId,
      count: this.schedules.length,
    });

    for (const def of this.schedules) {
      await this.di.storage.save("schedules", def.name, def);
    }

    // Seed initial nextRunAt
    const existing = await this.di.storage.list<any>("schedules");
    const now = new Date();

    for (const record of existing) {
      if (record.nextRunAt !== null && record.nextRunAt !== undefined) continue;

      const def = this.schedules.find((s) => s.name === record.name);
      if (!def) continue;

      const nextRun = this.computeNextRun(def, now);
      if (nextRun) {
        await this.di.storage.save("schedules", def.name, {
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
        this.di.lock,
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
    this.tickTimer.unref();

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
                      "Failed to commit stall telemetry for cron",
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
        `Scheduler draining ${activePromises.length} active jobs...`,
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
    this.logger.info("Scheduler stopped");
  }

  async triggerManual(scheduleId: string): Promise<boolean> {
    const def = this.schedules.find((s) => s.name === scheduleId);
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
    const knownSchedules = await this.di.storage.list<any>("schedules");
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

    // Note: StallDetector is already started in start() with abort-capable
    // callbacks. Do NOT re-initialize here — it would overwrite the abort
    // callback with a weaker log-only version, silently disabling crash recovery.
  }

  private async detectClusterStalls() {
    try {
      const activeDbJobs = await this.di.storage.list<any>("jobs", {
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

  // ── Tick loop ───────────────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (!this.enabled) return;

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
      const allSchedules = await this.di.storage.list<any>("schedules");

      const due = allSchedules.filter(
        (s: any) => s.nextRunAt && new Date(s.nextRunAt) <= now,
      );

      for (const record of due) {
        const def = this.schedules.find((s) => s.name === record.name);
        if (!def) continue;

        // ── Disabled behavior enforcement ──────────────────────────────────
        if (record.paused) {
          const behavior =
            def.disabledBehavior ?? this.config?.disabledBehavior ?? "hold";

          // ALL disabled behaviors must advance the nextRunAt, otherwise we infinite-loop
          // every tick since the record stays in the past.
          const nextRun = this.computeNextRun(def, now);
          if (nextRun) {
            await this.di.storage.save("schedules", def.name, {
              ...record,
              nextRunAt: nextRun,
              lastRunAt: now,
            });
          }

          if (behavior === "skip") {
            continue; // Silently skip
          }

          if (behavior === "reject") {
            this.logger.warn("Cron fire rejected — instance is disabled", {
              name: def.name,
              behavior: "reject",
            });
            OqronEventBus.emit(
              "job:fail",
              "cron",
              record.name,
              new Error(
                `Cron ${def.name} is disabled and configured to reject fires`,
              ),
            );
            continue;
          }

          // behavior === "hold"
          const holdId = randomUUID();
          await this.di.storage.save("jobs", holdId, {
            id: holdId,
            type: "cron",
            queueName: "system_cron",
            moduleName: def.name,
            scheduleId: def.name,
            status: "paused",
            pausedReason: "disabled-hold",
            data: null,
            opts: {},
            attemptMade: 0,
            progressPercent: 0,
            workerId: this.nodeId,
            tags: def.tags ?? [],
            environment: this.environment ?? "default",
            project: this.project ?? "default",
            queuedAt: now,
            triggeredBy: "cron",
            logs: [
              {
                level: "warn",
                msg: `Cron ${def.name} fired while disabled — job held`,
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

          this.logger.info("Cron fire held — instance is disabled", {
            name: def.name,
            holdId,
          });
          continue;
        }

        // CRITICAL: Compute and persist nextRunAt BEFORE firing.
        const nextRun = this.computeNextRun(def, now);
        if (!nextRun) {
          this.logger.error(
            "Cannot compute next run — suspending cron to prevent runaway loop",
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

    if (!acquired) return; // Cluster overlap protection

    const abort = new AbortController();
    const entry: ActiveJobEntry = { runId, lockKey, worker, abort };
    this.activeJobs.set(runId, entry);

    await this.di.storage.save("jobs", runId, {
      id: runId,
      type: "cron",
      queueName: "system_cron",
      moduleName: def.name,
      scheduleId: def.name,
      status: "active",
      data: null,
      opts: {},
      attemptMade: 0,
      progressPercent: 0,
      workerId: this.nodeId,
      tags: def.tags ?? [],
      environment: this.environment ?? "default",
      project: this.project ?? "default",
      queuedAt: new Date(),
      triggeredBy: "cron",
      logs: [],
      timeline: [
        {
          ts: startedAt,
          from: "waiting",
          to: "active",
          reason: `Cron ${def.name} fired`,
        },
      ],
      steps: [],
      startedAt,
    });

    // ── Execute handler (non-blocking) ────────────────────────────────────
    OqronEventBus.emit("job:start", "cron", runId, def.name);
    entry.promise = Promise.resolve().then(async () => {
      // Local accumulator — guarantees no log entries are lost to async races
      const localLogs: Array<{ level: string; msg: string; ts: Date }> = [];
      const localTimeline: Array<{
        ts: Date;
        from: string;
        to: string;
        reason: string;
      }> = [];

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
            localTimeline.push({
              ts: new Date(),
              from: "active",
              to: "active",
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
            this.logger.error("Failed to update progress", { runId, err });
          }
        },
        onLog: (level, msg) => {
          // Synchronous push — no async race, no lost logs
          (this.logger as any)[level]?.(`[Cron:${def.name}] ${msg}`, { runId });
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
      const existingJob = (await this.di.storage.get<any>("jobs", runId)) ?? {};

      // Push the final completion event into local accumulator
      localTimeline.push({
        ts: finishedAt,
        from: "active",
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
        type: "cron",
        queueName: "system_cron",
        moduleName: def.name,
        scheduleId: def.name,
        status,
        data: null,
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

      if (worker) {
        await worker.stop();
      } else {
        await this.di.lock.release(lockKey, this.nodeId).catch(() => {});
      }

      this.activeJobs.delete(runId);

      // Update nextRunAt after completion
      if (def.intervalMs) {
        const nextRun = this.computeNextRun(def, new Date());
        if (nextRun) {
          const record = await this.di.storage.get<any>("schedules", def.name);
          if (record) {
            await this.di.storage.save("schedules", def.name, {
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
