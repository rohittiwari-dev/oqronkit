import { randomUUID } from "node:crypto";
import {
  CronContext,
  type CronDefinition,
  createLogger,
  type IChronoAdapter,
  type IChronoModule,
  type ILockAdapter,
  type Logger,
} from "@chronoforge/core";
import { HeartbeatWorker, LeaderElection } from "@chronoforge/lock";
import { getNextRunDate } from "./expression-parser.js";

export class SchedulerModule implements IChronoModule {
  public readonly name = "cron";
  public readonly enabled = true;

  private readonly nodeId: string;
  private readonly logger: Logger;
  private leader?: LeaderElection;
  private tickTimer?: ReturnType<typeof setInterval>;
  // key = scheduleId, prevents overlapping runs when overlap=false
  private readonly activeJobs = new Map<string, HeartbeatWorker>();

  constructor(
    private readonly schedules: CronDefinition[],
    private readonly db: IChronoAdapter,
    private readonly lock: ILockAdapter,
    logger?: Logger,
  ) {
    this.nodeId = randomUUID();
    this.logger =
      logger ?? createLogger({ level: "info" }, { module: "scheduler" });
  }

  async init(): Promise<void> {
    this.logger.info("Initializing scheduler", {
      nodeId: this.nodeId,
      count: this.schedules.length,
    });
    for (const def of this.schedules) {
      await this.db.upsertSchedule(def);
      this.logger.debug("Registered schedule", {
        name: def.name,
        schedule: def.schedule,
      });
    }
  }

  async start(): Promise<void> {
    this.leader = new LeaderElection(
      this.lock,
      this.logger,
      "chrono:scheduler:leader",
      this.nodeId,
      30_000,
    );
    await this.leader.start();
    this.tickTimer = setInterval(() => {
      void this.tick();
    }, 1_000);
    this.logger.info("Scheduler started", { nodeId: this.nodeId });
  }

  private async tick(): Promise<void> {
    if (!this.leader?.isLeader) return;
    try {
      const due = await this.db.getDueSchedules(new Date(), 50);
      for (const { name } of due) {
        const def = this.schedules.find((s) => s.name === name);
        if (!def) continue;
        void this.fire(def);
      }
    } catch (err) {
      this.logger.error("Tick error", { err: String(err) });
    }
  }

  private async fire(def: CronDefinition): Promise<void> {
    const isOverlapSkip = def.overlap === "skip" || def.overlap === false;
    if (isOverlapSkip && this.activeJobs.has(def.name)) {
      this.logger.debug("Skipping overlapping run", { name: def.name });
      return;
    }

    const runId = randomUUID();
    const worker = new HeartbeatWorker(
      this.lock,
      this.logger,
      `chrono:run:${def.name}`,
      this.nodeId,
      30_000,
    );

    const acquired = await worker.start();
    if (!acquired) return;

    this.activeJobs.set(def.name, worker);
    const startedAt = new Date();
    await this.db.recordExecution({
      id: runId,
      scheduleId: def.name,
      status: "running",
      startedAt,
    });

    void Promise.resolve().then(async () => {
      const abort = new AbortController();
      const ctx = new CronContext({
        id: runId,
        logger: this.logger.child({ schedule: def.name }),
        signal: abort.signal,
        firedAt: startedAt,
        scheduleName: def.name,
      });

      let status: "completed" | "failed" = "completed";
      let error: string | undefined;

      try {
        await def.handler(ctx);
      } catch (err: unknown) {
        status = "failed";
        error = err instanceof Error ? err.message : String(err);
        this.logger.error("Job handler threw", {
          name: def.name,
          runId,
          error,
        });
      } finally {
        const completedAt = new Date();
        await this.db.recordExecution({
          id: runId,
          scheduleId: def.name,
          status,
          startedAt,
          completedAt,
          error,
        });
        await worker.stop();
        this.activeJobs.delete(def.name);
        try {
          getNextRunDate(def.schedule, def.timezone);
        } catch {
          /* expression was already validated */
        }
        this.logger.info("Job finished", { name: def.name, runId, status });
      }
    });
  }

  async stop(): Promise<void> {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.leader) await this.leader.stop();
    for (const worker of this.activeJobs.values()) await worker.stop();
    this.activeJobs.clear();
    this.logger.info("Scheduler stopped");
  }
}
