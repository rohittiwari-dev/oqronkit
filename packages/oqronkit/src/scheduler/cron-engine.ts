import { randomUUID } from "node:crypto";
import {
  Broker,
  type CronDefinition,
  createLogger,
  type IOqronModule,
  LagMonitor,
  type Logger,
  OqronEventBus,
  type OqronJob,
  Storage,
} from "../engine/index.js";
import { getNextRunDate } from "./expression-parser.js";
import { MissedFireHandler } from "./missed-fire.handler.js";

export class SchedulerModule implements IOqronModule {
  public readonly name = "cron";
  public readonly enabled = true;

  private readonly nodeId: string;
  private readonly logger: Logger;
  private lagMonitor: LagMonitor;
  private missedFireHandler: MissedFireHandler;
  private tickTimer?: ReturnType<typeof setInterval>;

  private _hasRunLeaderInit = false;

  constructor(
    private readonly schedules: CronDefinition[],
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
    this.missedFireHandler = new MissedFireHandler(this.logger);
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
    const interval = this.config?.tickInterval ?? 1_000;
    this.tickTimer = setInterval(() => {
      void this.tick();
    }, interval);

    this.logger.info("Scheduler trigger started", { nodeId: this.nodeId });
    this.lagMonitor.start();
  }

  async stop(): Promise<void> {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.lagMonitor.stop();
    this.logger.info("Scheduler stopped");
  }

  // ── Core triggering logic ──────────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (!this._hasRunLeaderInit) {
      this._hasRunLeaderInit = true;
      await this.handleLeaderInit();
    }

    try {
      if (this.lagMonitor.isCircuitTripped) return;

      const now = new Date();
      const allSchedules = await Storage.list<any>("schedules");

      // Find due schedules
      const dueSchedules = allSchedules.filter(
        (s: any) => s.nextRunAt && new Date(s.nextRunAt) <= now && !s.paused,
      );

      for (const record of dueSchedules) {
        const def = this.schedules.find((s) => s.name === record.name);
        if (!def) continue;

        const nextRun = this.computeNextRun(def, now);
        await Storage.save("schedules", def.name, {
          ...record,
          nextRunAt: nextRun,
          lastRunAt: now,
        });

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
      queueName: "cron-default",
      status: "waiting",
      data: {},
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

    // 1. Persist to Storage
    await Storage.save("jobs", jobId, job);

    // 2. Signal Broker
    await Broker.publish(job.queueName, jobId);

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
        this.logger.info("Recovering missed fire", { name: def.name });
        await this.enqueueJob(def);
      }
    }
  }
}
