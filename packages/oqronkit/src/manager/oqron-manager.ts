import { Broker, OqronRegistry, Storage } from "../engine/index.js";
import type { OqronConfig } from "../engine/types/config.types.js";
import type { JobStatus, OqronJob } from "../engine/types/job.types.js";

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

    // In new engine we don't have getSystemStats on DB directly yet, stubbed
    const dbStats = {
      keys: await Storage.list("jobs").then((x) => x.length),
    };

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
  ): Promise<{ metrics: any; jobs: OqronJob[] }> {
    const state = opts.state ?? "waiting";
    const allJobs = await Storage.list<OqronJob>("jobs");

    const queueJobs = allJobs.filter((j) => j.queueName === name);

    const metricsResult = {
      active: queueJobs.filter((j) => j.status === "active").length,
      waiting: queueJobs.filter((j) => j.status === "waiting").length,
      completed: queueJobs.filter((j) => j.status === "completed").length,
      failed: queueJobs.filter((j) => j.status === "failed").length,
      delayed: queueJobs.filter((j) => j.status === "delayed").length,
      paused: 0,
    };

    const jobs = queueJobs
      .filter((j) => j.status === state)
      .slice(opts.offset ?? 0, (opts.offset ?? 0) + (opts.limit ?? 50));

    return { metrics: metricsResult, jobs };
  }

  async pauseQueue(name: string): Promise<void> {
    await Broker.pause(name);
  }

  async resumeQueue(name: string): Promise<void> {
    await Broker.resume(name);
  }

  async retryAllFailed(name: string): Promise<number> {
    const allJobs = await Storage.list<OqronJob>("jobs");
    const failedJobs = allJobs
      .filter((j) => j.queueName === name && j.status === "failed")
      .slice(0, 1000);

    let retried = 0;
    for (const job of failedJobs) {
      await this.retryJob(job.id);
      retried++;
    }

    return retried;
  }

  // ── Job Management ─────────────────────────────────────────────────────────

  async getJob(jobId: string): Promise<OqronJob | null> {
    return Storage.get<OqronJob>("jobs", jobId);
  }

  async retryJob(jobId: string): Promise<void> {
    const job = await Storage.get<OqronJob>("jobs", jobId);
    if (!job || job.status !== "failed") return;

    job.status = "waiting";
    job.attemptMade = 0;
    job.error = undefined;
    job.stacktrace = undefined;

    await Storage.save("jobs", job.id, job);
    await Broker.publish(job.queueName, job.id, job.opts.delay);
  }

  async cancelJob(jobId: string): Promise<void> {
    await Storage.delete("jobs", jobId);
  }
}
