import { AdapterRegistry } from "../core/adapter-registry.js";
import { OqronRegistry } from "../core/registry.js";
import type { OqronConfig } from "../core/types/config.types.js";
import type { JobStatus, OqronJob } from "../core/types/job.types.js";
import type { QueueMetrics } from "../core/types/queue.types.js";

/**
 * OqronManager — centralized administration and monitoring logic.
 * Orchestrates cross-module stats and provides a high-level API for the
 * dashboard handlers and CLI tools.
 */
export class OqronManager {
  private constructor(private readonly config: OqronConfig) {}

  /** Create a manager instance from a validated configuration */
  static from(config: OqronConfig): OqronManager {
    return new OqronManager(config);
  }

  // ── System Stats ───────────────────────────────────────────────────────────

  async getSystemStats(): Promise<any> {
    const registry = OqronRegistry.getInstance();
    const modules = registry.getAll();
    const db = AdapterRegistry.from(this.config).resolveDb();

    // Fallback if db doesn't implement getSystemStats (old adapter vs new)
    const dbStats = (db as any).getSystemStats
      ? await (db as any).getSystemStats()
      : {};

    return {
      project: this.config.project ?? "unnamed",
      env: this.config.environment ?? "development",
      uptime: process.uptime(),
      db: dbStats,
      modules: modules.map((m) => ({
        name: m.name,
        enabled: m.enabled,
        status: m.enabled ? "active" : "idle",
      })),
    };
  }

  // ── Queue Administration ───────────────────────────────────────────────────

  async getQueueInfo(
    name: string,
    opts: { state?: JobStatus; limit?: number; offset?: number } = {},
  ): Promise<{ metrics: QueueMetrics; jobs: OqronJob[] }> {
    const db = AdapterRegistry.from(this.config).resolveDb();
    const metricsResult = (db as any).getQueueMetrics
      ? await (db as any).getQueueMetrics(name)
      : {
          active: 0,
          waiting: 0,
          completed: 0,
          failed: 0,
          delayed: 0,
          paused: 0,
        };

    const state = opts.state ?? "waiting";
    const jobs = await db.listJobs({
      queueName: name,
      status: state,
      offset: opts.offset ?? 0,
      limit: opts.limit ?? 50,
    });

    return { metrics: metricsResult, jobs };
  }

  async pauseQueue(name: string): Promise<void> {
    const broker = AdapterRegistry.from(this.config).resolveBroker();
    await broker.setQueuePaused(name, true);
  }

  async resumeQueue(name: string): Promise<void> {
    const broker = AdapterRegistry.from(this.config).resolveBroker();
    await broker.setQueuePaused(name, false);
  }

  async retryAllFailed(name: string): Promise<number> {
    const db = AdapterRegistry.from(this.config).resolveDb();
    const failedJobs = await db.listJobs({
      queueName: name,
      status: "failed",
      limit: 1000,
    });

    let retried = 0;
    for (const job of failedJobs) {
      await this.retryJob(job.id);
      retried++;
    }

    return retried;
  }

  // ── Job Management ─────────────────────────────────────────────────────────

  async getJob(jobId: string): Promise<OqronJob | null> {
    const db = AdapterRegistry.from(this.config).resolveDb();
    return db.getJob(jobId);
  }

  async retryJob(jobId: string): Promise<void> {
    const db = AdapterRegistry.from(this.config).resolveDb();
    const broker = AdapterRegistry.from(this.config).resolveBroker();

    const job = await db.getJob(jobId);
    if (!job || job.status !== "failed") return;

    job.status = "waiting";
    job.attemptMade = 0;
    job.error = undefined;
    job.stacktrace = undefined;

    await db.upsertJob(job);
    await broker.signalEnqueue(job.queueName, job.id, job.opts.delay);
  }

  async cancelJob(jobId: string): Promise<void> {
    const db = AdapterRegistry.from(this.config).resolveDb();
    await db.deleteJob(jobId);
  }
}
