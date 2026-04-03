import { randomUUID } from "node:crypto";
import { Broker, OqronRegistry, Storage } from "../engine/index.js";
import type { OqronConfig } from "../engine/types/config.types.js";
import type {
  JobFilter,
  JobStatus,
  JobType,
  OqronJob,
} from "../engine/types/job.types.js";

// ── Result types ────────────────────────────────────────────────────────────

export interface ModuleInfo {
  name: string;
  enabled: boolean;
  status: "active" | "idle" | "stopped";
}

export interface QueueMetrics {
  active: number;
  waiting: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
}

export interface QueueInfoResult {
  metrics: QueueMetrics;
  jobs: OqronJob[];
}

export interface JobHistoryResult {
  jobs: OqronJob[];
  total: number;
}

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

  // ── Module Management ─────────────────────────────────────────────────────

  /** List all registered modules with their current state */
  listModules(): ModuleInfo[] {
    const registry = OqronRegistry.getInstance();
    return registry.getAll().map((m) => ({
      name: m.name,
      enabled: m.enabled,
      status: m.enabled ? "active" : ("idle" as const),
    }));
  }

  /**
   * Enable a module at runtime.
   * If the module implements `enable()`, it will resume ticking/polling.
   * Otherwise, sets `enabled = true` and calls `start()`.
   */
  async enableModule(moduleName: string): Promise<boolean> {
    const registry = OqronRegistry.getInstance();
    const mod = registry.get(moduleName);
    if (!mod) return false;

    if (mod.enabled) return true; // Already enabled — no-op

    if (mod.enable) {
      await mod.enable();
    } else {
      mod.enabled = true;
      await mod.start();
    }

    return true;
  }

  /**
   * Disable a module at runtime.
   * If the module implements `disable()`, it will gracefully drain and stop.
   * Otherwise, sets `enabled = false` and calls `stop()`.
   */
  async disableModule(moduleName: string): Promise<boolean> {
    const registry = OqronRegistry.getInstance();
    const mod = registry.get(moduleName);
    if (!mod) return false;

    if (!mod.enabled) return true; // Already disabled — no-op

    if (mod.disable) {
      await mod.disable();
    } else {
      mod.enabled = false;
      await mod.stop();
    }

    return true;
  }

  /**
   * Manually trigger a named schedule/job within any registered module.
   * Scans all modules for a matching `triggerManual()` handler.
   *
   * @returns `true` if any module claimed and triggered the schedule
   */
  async triggerModule(scheduleId: string): Promise<boolean> {
    const registry = OqronRegistry.getInstance();
    for (const mod of registry.getAll()) {
      if (mod.enabled && mod.triggerManual) {
        const claimed = await mod.triggerManual(scheduleId);
        if (claimed) return true;
      }
    }
    return false;
  }

  // ── Queue Administration ───────────────────────────────────────────────────

  async getQueueInfo(
    name: string,
    opts: { state?: JobStatus; limit?: number; offset?: number } = {},
  ): Promise<QueueInfoResult> {
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

    const metricsResult: QueueMetrics = {
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

  /**
   * Retry a failed job by creating a NEW job record with a `retriedFromId`
   * memoization link to the original. The original job's status is updated
   * to indicate it has been retried.
   *
   * This ensures full audit trail — the original failure record is preserved,
   * and the new retry record can be independently tracked.
   */
  async retryJob(jobId: string): Promise<string | undefined> {
    const job = await Storage.get<OqronJob>("jobs", jobId);
    if (!job || job.status !== "failed") return undefined;

    // Create a new job record linked to the original
    const retryId = randomUUID();
    const retryJob: OqronJob = {
      ...job,
      id: retryId,
      status: "waiting",
      attemptMade: 0,
      error: undefined,
      stacktrace: undefined,
      returnValue: undefined,
      retriedFromId: jobId,
      triggeredBy: "retry",
      createdAt: new Date(),
      startedAt: undefined,
      finishedAt: undefined,
      durationMs: undefined,
      latencyMs: undefined,
      memoryUsageMb: undefined,
      processedOn: undefined,
      queuedAt: new Date(),
      logs: undefined,
      timeline: undefined,
      steps: undefined,
      progressPercent: 0,
      progressLabel: undefined,
      workerId: undefined,
      stalledCount: undefined,
    };

    // Save the new retry job
    await Storage.save("jobs", retryId, retryJob);

    // Mark original as "retried" in retryReason for audit
    await Storage.save("jobs", jobId, {
      ...job,
      retryReason: `Retried as ${retryId}`,
    });

    // Publish to broker for processing
    await Broker.publish(retryJob.queueName, retryId, retryJob.opts.delay);

    return retryId;
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

  // ── Job Queries ────────────────────────────────────────────────────────────

  /**
   * Get jobs filtered by type (cron, schedule, task, webhook, batch, workflow).
   * Supports pagination via limit/offset.
   */
  async getJobsByType(
    type: JobType,
    opts: { status?: JobStatus; limit?: number; offset?: number } = {},
  ): Promise<JobHistoryResult> {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    const filter: Record<string, unknown> = { type };
    if (opts.status) filter.status = opts.status;

    const [jobs, total] = await Promise.all([
      Storage.list<OqronJob>("jobs", filter, { limit, offset }),
      Storage.count("jobs", filter),
    ]);

    return { jobs, total };
  }

  /**
   * Get execution history for a specific schedule/module by its definition name.
   * Useful for viewing all past runs of a particular cron or scheduled task.
   */
  async getJobHistory(
    scheduleId: string,
    opts: { status?: JobStatus; limit?: number; offset?: number } = {},
  ): Promise<JobHistoryResult> {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    const filter: Record<string, unknown> = { scheduleId };
    if (opts.status) filter.status = opts.status;

    const [jobs, total] = await Promise.all([
      Storage.list<OqronJob>("jobs", filter, { limit, offset }),
      Storage.count("jobs", filter),
    ]);

    return { jobs, total };
  }

  /**
   * Get jobs filtered by a generic JobFilter.
   * Provides full control over querying the unified jobs namespace.
   */
  async queryJobs(filter: JobFilter): Promise<JobHistoryResult> {
    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;

    const storageFilter: Record<string, unknown> = {};
    if (filter.type) storageFilter.type = filter.type;
    if (filter.status) storageFilter.status = filter.status;
    if (filter.queueName) storageFilter.queueName = filter.queueName;
    if (filter.scheduleId) storageFilter.scheduleId = filter.scheduleId;

    const [jobs, total] = await Promise.all([
      Storage.list<OqronJob>("jobs", storageFilter, { limit, offset }),
      Storage.count("jobs", storageFilter),
    ]);

    return { jobs, total };
  }

  /**
   * Get the retry chain for a job — follows the `retriedFromId` link backwards
   * and also finds any retries that were created from this job.
   */
  async getRetryChain(jobId: string): Promise<OqronJob[]> {
    const chain: OqronJob[] = [];
    const visited = new Set<string>();

    // Walk backwards through retriedFromId
    let currentId: string | undefined = jobId;
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const job: OqronJob | null = await Storage.get<OqronJob>(
        "jobs",
        currentId,
      );
      if (!job) break;
      chain.unshift(job); // prepend to maintain chronological order
      currentId = job.retriedFromId;
    }

    // Walk forwards — find retries created from this job
    const forwardRetries = await Storage.list<OqronJob>("jobs", {
      retriedFromId: jobId,
    });
    for (const retry of forwardRetries) {
      if (!visited.has(retry.id)) {
        visited.add(retry.id);
        chain.push(retry);
      }
    }

    return chain;
  }
}
