import { randomUUID } from "node:crypto";
import {
  type CronDefinition,
  createLogger,
  type ILockAdapter,
  type IOqronAdapter,
  type IOqronModule,
  type IQueueAdapter,
  LagMonitor,
  type Logger,
  OqronEventBus,
  type OqronJob,
} from "../core/index.js";
import { LeaderElection } from "../lock/index.js";
import { getNextRunDate } from "./expression-parser.js";
import { MissedFireHandler } from "./missed-fire.handler.js";

export class SchedulerModule implements IOqronModule {
  public readonly name = "cron";
  public readonly enabled = true;

  private readonly nodeId: string;
  private readonly logger: Logger;
  private leader?: LeaderElection;
  private lagMonitor: LagMonitor;
  private missedFireHandler: MissedFireHandler;
  private tickTimer?: ReturnType<typeof setInterval>;

  private _hasRunLeaderInit = false;

  constructor(
    private readonly schedules: CronDefinition[],
    private readonly db: IOqronAdapter,
    private readonly lock: ILockAdapter,
    private readonly broker: IQueueAdapter,
    logger?: Logger,
    _environment?: string,
    _project?: string,
    private readonly config?: {
      enable?: boolean;
      timezone?: string;
      tickInterval?: number;
      leaderElection?: boolean;
      lagMonitor?: { maxLagMs?: number; sampleIntervalMs?: number };
    },
  ) {
    this.nodeId = randomUUID();
    this.logger =
      logger ?? createLogger({ level: "info" }, { module: "scheduler" });
    this.lagMonitor = new LagMonitor(
      this.logger,
      this.config?.lagMonitor?.maxLagMs ?? 500,
      this.config?.lagMonitor?.sampleIntervalMs ?? 50,
    );
    this.missedFireHandler = new MissedFireHandler(this.logger, this.db);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    this.logger.info("Initializing scheduler (Unified Model)", {
      nodeId: this.nodeId,
      count: this.schedules.length,
    });

    for (const def of this.schedules) {
      await this.db.upsertSchedule(def);
    }

    // Seed initial nextRunAt
    const existing = await this.db.getSchedules();
    const now = new Date();

    for (const record of existing) {
      if (record.nextRunAt !== null) continue;

      const def = this.schedules.find((s) => s.name === record.id);
      if (!def) continue;

      const nextRun = this.computeNextRun(def, now);
      if (nextRun) {
        await this.db.updateScheduleNextRun(def.name, nextRun);
      }
    }
  }

  async start(): Promise<void> {
    if (this.config?.leaderElection !== false) {
      this.leader = new LeaderElection(
        this.lock,
        this.logger,
        "oqron:scheduler:leader",
        this.nodeId,
        30_000,
      );
      await this.leader.start();
    }

    const interval = this.config?.tickInterval ?? 1_000;
    this.tickTimer = setInterval(() => {
      void this.tick();
    }, interval);

    this.logger.info("Scheduler trigger started", { nodeId: this.nodeId });
    this.lagMonitor.start();
  }

  async stop(): Promise<void> {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.leader) await this.leader.stop();
    this.lagMonitor.stop();
    this.logger.info("Scheduler stopped");
  }

  // ── Core triggering logic ──────────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (this.leader && !this.leader.isLeader) return;

    if (!this._hasRunLeaderInit) {
      this._hasRunLeaderInit = true;
      await this.handleLeaderInit();
    }

    try {
      if (this.lagMonitor.isCircuitTripped) return;

      const now = new Date();
      const dueIds = await this.db.getDueSchedules(now, 50);

      for (const id of dueIds) {
        const def = this.schedules.find((s) => s.name === id);
        if (!def) continue;

        const nextRun = this.computeNextRun(def, now);
        await this.db.updateScheduleNextRun(id, nextRun);

        await this.enqueueJob(def);
      }
    } catch (err) {
      this.logger.error("Tick error", { err: String(err) });
    }
  }

  private async enqueueJob(def: CronDefinition): Promise<void> {
    const jobId = randomUUID();

    const job: OqronJob = {
      id: jobId,
      type: "cron",
      queueName: "cron-default", // Default queue for cron executions
      status: "waiting",
      data: {}, // Cron handlers usually use context, not payload data
      opts: {
        attempts: (def.retries?.max ?? 0) + 1,
        backoff: def.retries
          ? { type: def.retries.strategy, delay: def.retries.baseDelay }
          : undefined,
      },
      attemptMade: 0,
      progressPercent: 0,
      scheduleId: def.name,
      tags: def.tags,
      createdAt: new Date(),
    };

    // 1. Persist to DB (Storage)
    await this.db.upsertJob(job);

    // 2. Signal Broker (Transport)
    await this.broker.signalEnqueue(job.queueName, jobId);

    this.logger.debug("Cron triggered", { schedule: def.name, jobId });
    OqronEventBus.emit("job:start", "cron", jobId, def.name);
  }

  private computeNextRun(def: CronDefinition, from: Date): Date | null {
    if (def.expression) {
      const timezone = def.timezone ?? this.config?.timezone;
      return getNextRunDate(def.expression, timezone, from);
    }
    return def.intervalMs ? new Date(from.getTime() + def.intervalMs) : null;
  }

  private async handleLeaderInit(): Promise<void> {
    const knownSchedules = await this.db.getSchedules();
    const now = new Date();

    for (const record of knownSchedules) {
      const def = this.schedules.find((s) => s.name === record.id);
      if (!def) continue;

      const missed = await this.missedFireHandler.checkMissed(
        def,
        record.lastRunAt,
        now,
      );
      if (missed) {
        this.logger.info("Recovering missed fire", { name: def.name });
        await this.enqueueJob(def);
      }
    }
  }
}
