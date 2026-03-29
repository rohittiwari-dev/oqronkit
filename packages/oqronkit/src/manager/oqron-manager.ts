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

    const totalJobs = await Storage.count("jobs");

    return {
      project: this.config.project ?? "unnamed",
      env: this.config.environment ?? "development",
      uptime: process.uptime(),
      db: { keys: totalJobs },
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
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    // Fetch metrics counts via parallel count queries — NOT full-scan
    const [active, waiting, completed, failed, delayed] = await Promise.all([
      Storage.count("jobs", { queueName: name, status: "active" }),
      Storage.count("jobs", { queueName: name, status: "waiting" }),
      Storage.count("jobs", { queueName: name, status: "completed" }),
      Storage.count("jobs", { queueName: name, status: "failed" }),
      Storage.count("jobs", { queueName: name, status: "delayed" }),
    ]);

    const metricsResult = {
      active,
      waiting,
      completed,
      failed,
      delayed,
      paused: 0,
    };

    // Fetch only the requested page of jobs with the target state
    const jobs = await Storage.list<OqronJob>(
      "jobs",
      { queueName: name, status: state },
      { limit, offset },
    );

    return { metrics: metricsResult, jobs };
  }

  async pauseQueue(name: string): Promise<void> {
    await Broker.pause(name);
  }

  async resumeQueue(name: string): Promise<void> {
    await Broker.resume(name);
  }

  async retryAllFailed(name: string): Promise<number> {
    const failedJobs = await Storage.list<OqronJob>(
      "jobs",
      { queueName: name, status: "failed" },
      { limit: 1000 },
    );

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
    const job = await Storage.get<OqronJob>("jobs", jobId);

    // If the job is actively running, try to abort it via the engine
    if (job && job.status === "active") {
      const registry = OqronRegistry.getInstance();
      for (const mod of registry.getAll()) {
        if (mod.cancelActiveJob) {
          const cancelled = await mod.cancelActiveJob(jobId);
          if (cancelled) return; // Engine handled cleanup + storage update
        }
      }
    }

    // For non-active jobs or if no engine claimed it, just delete from storage
    await Storage.delete("jobs", jobId);
  }
}
