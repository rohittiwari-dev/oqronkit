import {
  type ChronoLogger,
  CronContext,
  type CronDefinition,
  createLogger,
  type IChronoAdapter,
  type IChronoModule,
  type ILockAdapter,
} from "@chronoforge/core";
import { HeartbeatWorker, LeaderElection } from "@chronoforge/lock";
import { randomUUID } from "crypto";
import { getNextRunDate } from "./expression-parser.js";

export class SchedulerModule implements IChronoModule {
  public readonly name = "cron";
  public readonly enabled = true;

  private readonly nodeId: string;
  private readonly logger: ChronoLogger;
  private leader?: LeaderElection;
  private tickTimer?: ReturnType<typeof setInterval>;
  // key = scheduleId, prevents overlapping runs when overlap=false
  private readonly activeJobs = new Map<string, HeartbeatWorker>();

  constructor(
    private readonly schedules: CronDefinition[],
    private readonly db: IChronoAdapter,
    private readonly lock: ILockAdapter,
    logger?: ChronoLogger,
  ) {
    this.nodeId = randomUUID();
    this.logger =
      logger ?? createLogger({ level: "info", module: "scheduler" });
  }

  async init(): Promise<void> {
    this.logger.info("Initializing scheduler", {
      nodeId: this.nodeId,
      count: this.schedules.length,
    });
    for (const def of this.schedules) {
      await this.db.upsertSchedule(def);
      this.logger.debug("Registered schedule", {
        id: def.id,
        expression: def.expression,
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
      for (const { id } of due) {
        const def = this.schedules.find((s) => s.id === id);
        if (!def) continue;
        void this.fire(def);
      }
    } catch (err) {
      this.logger.error("Tick error", { err: String(err) });
    }
  }

  private async fire(def: CronDefinition): Promise<void> {
    if (!def.overlap && this.activeJobs.has(def.id)) {
      this.logger.debug("Skipping overlapping run", { id: def.id });
      return;
    }

    const runId = randomUUID();
    const worker = new HeartbeatWorker(
      this.lock,
      this.logger,
      `chrono:run:${def.id}`,
      this.nodeId,
      30_000,
    );

    const acquired = await worker.start();
    if (!acquired) return;

    this.activeJobs.set(def.id, worker);
    const startedAt = new Date();
    await this.db.recordExecution({
      id: runId,
      scheduleId: def.id,
      status: "running",
      startedAt,
    });

    void Promise.resolve().then(async () => {
      const abort = new AbortController();
      const ctx = new CronContext({
        id: runId,
        logger: this.logger.child(def.id),
        signal: abort.signal,
        firedAt: startedAt,
        scheduleName: def.id,
      });

      let status: "completed" | "failed" = "completed";
      let error: string | undefined;

      try {
        await def.handler(ctx);
      } catch (err: unknown) {
        status = "failed";
        error = err instanceof Error ? err.message : String(err);
        this.logger.error("Job handler threw", { id: def.id, runId, error });
      } finally {
        const completedAt = new Date();
        await this.db.recordExecution({
          id: runId,
          scheduleId: def.id,
          status,
          startedAt,
          completedAt,
          error,
        });
        await worker.stop();
        this.activeJobs.delete(def.id);
        try {
          getNextRunDate(def.expression, def.timezone);
        } catch {
          /* expression was already validated */
        }
        this.logger.info("Job finished", { id: def.id, runId, status });
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
