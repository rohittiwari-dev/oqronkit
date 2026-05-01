import { randomUUID } from "node:crypto";
import { Broker, OqronEventBus, OqronRegistry, Storage } from "../engine/index.js";
import type { OqronConfig } from "../engine/types/config.types.js";
import type {
  JobFilter,
  JobStatus,
  JobType,
  OqronJob,
} from "../engine/types/job.types.js";
import type {
  RateLimitEvent,
  RateLimitInstanceRecord,
  RateLimitKeyStatus,
  RateLimitStats,
} from "../ratelimit/types.js";
import { getLimiter } from "../ratelimit/registry.js";

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

  // ── Instance Management ───────────────────────────────────────────────────

  /**
   * Enable a specific registered instance (e.g., a specific queue or cron definition).
   */
  async enableInstance(type: JobType, name: string): Promise<boolean> {
    if (type === "task" || type === ("queue" as any)) {
      await this.resumeQueue(name);
      return true;
    }
    if (type === "cron" || type === "schedule") {
      const ns = type === "cron" ? "cron_schedules" : "schedule_schedules";
      const def = await Storage.get<any>(ns, name)
        ?? await Storage.get<any>(type === "cron" ? "schedule_schedules" : "cron_schedules", name);
      if (def) {
        const actualNs = def.type === "cron" ? "cron_schedules" : "schedule_schedules";
        def.paused = false;
        await Storage.save(actualNs, name, def);
        OqronEventBus.emit("schedule:resumed", name);
        return true;
      }
    }
    if (type === ("ratelimit" as any)) {
      return this.enableRateLimiter(name);
    }
    return false;
  }

  /**
   * Disable a specific registered instance (e.g., a specific queue or cron definition).
   */
  async disableInstance(type: JobType, name: string): Promise<boolean> {
    if (type === "task" || type === ("queue" as any)) {
      await this.pauseQueue(name);
      return true;
    }
    if (type === "cron" || type === "schedule") {
      const ns = type === "cron" ? "cron_schedules" : "schedule_schedules";
      const def = await Storage.get<any>(ns, name)
        ?? await Storage.get<any>(type === "cron" ? "schedule_schedules" : "cron_schedules", name);
      if (def) {
        const actualNs = def.type === "cron" ? "cron_schedules" : "schedule_schedules";
        def.paused = true;
        await Storage.save(actualNs, name, def);
        OqronEventBus.emit("schedule:paused", name);
        return true;
      }
    }
    if (type === ("ratelimit" as any)) {
      return this.disableRateLimiter(name);
    }
    return false;
  }
  // ──  Schedule Instance Listing ───────────────────────────────────────────

  /**
   * List all registered cron and schedule instances with their current state.
   * Merges both namespaces and optionally filters by type.
   */
  async listSchedules(opts?: { type?: "cron" | "schedule" }): Promise<any[]> {
    const [cronRecords, schedRecords] = await Promise.all([
      opts?.type === "schedule" ? [] : Storage.list<any>("cron_schedules"),
      opts?.type === "cron" ? [] : Storage.list<any>("schedule_schedules"),
    ]);
    return [...cronRecords, ...schedRecords];
  }

  // ──  Single Schedule Detail ─────────────────────────────────────────────

  /**
   * Get the full state of a single schedule/cron instance by name.
   * Checks both namespaces.
   */
  async getScheduleDetail(name: string): Promise<any | null> {
    return (await Storage.get<any>("cron_schedules", name))
      ?? (await Storage.get<any>("schedule_schedules", name));
  }

  // ── Rate Limiter Management ─────────────────────────────────────────────

  async listRateLimiters(): Promise<RateLimitInstanceRecord[]> {
    return Storage.list<RateLimitInstanceRecord>("ratelimit_instances");
  }

  async getRateLimiterStats(name: string): Promise<RateLimitStats | null> {
    return Storage.get<RateLimitStats>("ratelimit_stats", name);
  }

  async enableRateLimiter(name: string): Promise<boolean> {
    const rec = await Storage.get<RateLimitInstanceRecord>(
      "ratelimit_instances",
      name,
    );
    if (!rec) return false;
    rec.enabled = true;
    await Storage.save("ratelimit_instances", name, rec);
    OqronEventBus.emit("ratelimit:instance:enabled", name);
    return true;
  }

  async disableRateLimiter(name: string): Promise<boolean> {
    const rec = await Storage.get<RateLimitInstanceRecord>(
      "ratelimit_instances",
      name,
    );
    if (!rec) return false;
    rec.enabled = false;
    await Storage.save("ratelimit_instances", name, rec);
    OqronEventBus.emit("ratelimit:instance:disabled", name);
    return true;
  }

  async getRateLimiterEvents(
    name: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<{ events: RateLimitEvent[]; total: number }> {
    const filter = { limiterName: name };
    const [events, total] = await Promise.all([
      Storage.list<RateLimitEvent>("ratelimit_events", filter, opts),
      Storage.count("ratelimit_events", filter),
    ]);
    return { events, total };
  }

  async getRateLimiterKeyStatus(
    name: string,
    adminKey: string,
  ): Promise<RateLimitKeyStatus | null> {
    const limiter = getLimiter(name);
    if (!limiter) return null;
    return limiter.getStatus(adminKey);
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
    const queueEngine = OqronRegistry.getInstance().getAll().find((m) => m.name === "queue") as any;
    if (queueEngine && typeof queueEngine.pauseQueue === "function") {
      await queueEngine.pauseQueue(name);
    } else {
      const existing = await Storage.get<any>("queue_instances", name);
      await Storage.save("queue_instances", name, {
        ...(existing || {}),
        enabled: false,
      });
    }
    await Broker.pause(name);
  }

  async resumeQueue(name: string): Promise<void> {
    const queueEngine = OqronRegistry.getInstance().getAll().find((m) => m.name === "queue") as any;
    if (queueEngine && typeof queueEngine.resumeQueue === "function") {
      await queueEngine.resumeQueue(name);
    } else {
      const existing = await Storage.get<any>("queue_instances", name);
      await Storage.save("queue_instances", name, {
        ...(existing || {}),
        enabled: true,
      });
    }
    await Broker.resume(name);
  }

  async retryAllFailed(name: string): Promise<number> {
    const failedJobs = await Storage.list<OqronJob>(
      "jobs",
      { queueName: name, status: "failed" },
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
   *  Retry a failed job. For scheduler jobs (cron/schedule), triggers
   * the schedule directly instead of publishing to the Broker.
   * For queue/task jobs, creates a new job record with memoization link.
   */
  async retryJob(jobId: string): Promise<string | undefined> {
    const job = await Storage.get<OqronJob>("jobs", jobId);
    if (!job || job.status !== "failed") return undefined;

    //  Scheduler jobs don't use Broker — trigger via engine
    if (job.type === "cron" || job.type === "schedule") {
      const targetName = job.scheduleId ?? job.moduleName;
      if (!targetName) return undefined;

      const triggered = await this.triggerModule(targetName);
      if (triggered) {
        OqronEventBus.emit("job:retried", jobId, `triggered:${targetName}`);
        return `triggered:${targetName}`;
      }
      return undefined;
    }

    // Queue/task jobs: create new record + Broker
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

    await Storage.save("jobs", retryId, retryJob);
    await Storage.save("jobs", jobId, {
      ...job,
      retryReason: `Retried as ${retryId}`,
    });
    await Broker.publish(retryJob.queueName, retryId, retryJob.opts.delay);

    OqronEventBus.emit("job:retried", jobId, retryId);
    return retryId;
  }

  /**
   *  Rerun any job regardless of status (completed, failed, etc.).
   * For scheduler jobs: triggers the schedule engine directly.
   * For queue/task jobs: creates a new job record via Broker.
   */
  async rerunJob(jobId: string): Promise<string | undefined> {
    const job = await Storage.get<OqronJob>("jobs", jobId);
    if (!job) return undefined;

    if (job.type === "cron" || job.type === "schedule") {
      const targetName = job.scheduleId ?? job.moduleName;
      if (!targetName) return undefined;
      const triggered = await this.triggerModule(targetName);
      return triggered ? `triggered:${targetName}` : undefined;
    }

    // Queue/task: clone as new waiting job
    const rerunId = randomUUID();
    const rerunJob: OqronJob = {
      ...job,
      id: rerunId,
      status: "waiting",
      attemptMade: 0,
      error: undefined,
      stacktrace: undefined,
      returnValue: undefined,
      retriedFromId: jobId,
      triggeredBy: "rerun",
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

    await Storage.save("jobs", rerunId, rerunJob);
    await Broker.publish(rerunJob.queueName, rerunId, rerunJob.opts.delay);
    return rerunId;
  }

  async cancelJob(jobId: string): Promise<void> {
    const job = await Storage.get<OqronJob>("jobs", jobId);

    // If the job is actively running, try to abort it via the engine
    if (job && (job.status === "active" || job.status === "running")) {
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

  // ── G12: Webhook Management ─────────────────────────────────────────────────

  /** Get the WebhookEngine from the registry (if available) */
  private getWebhookEngine(): any | null {
    const registry = OqronRegistry.getInstance();
    const mod = registry.getAll().find((m) => m.name === "webhook");
    return mod ?? null;
  }

  /** List all registered webhook dispatchers */
  async listWebhookDispatchers(): Promise<
    Array<{
      name: string;
      enabled: boolean;
      endpointCount: number;
      version: number;
    }>
  > {
    const { getRegisteredWebhooks } = await import("../webhook/registry.js");
    const dispatchers = getRegisteredWebhooks();
    const results: Array<{
      name: string;
      enabled: boolean;
      endpointCount: number;
      version: number;
    }> = [];

    for (const d of dispatchers) {
      const instance = await Storage.get<any>("webhook_instances", d.name);
      const endpoints = Array.isArray(d.endpoints) ? d.endpoints : [];
      results.push({
        name: d.name,
        enabled: instance?.enabled ?? true,
        endpointCount: endpoints.length,
        version: d.version ?? 0,
      });
    }

    return results;
  }

  /** Get detailed info for a single webhook dispatcher */
  async getWebhookDispatcherDetail(
    name: string,
  ): Promise<{
    name: string;
    enabled: boolean;
    version: number;
    method: string;
    timeout: number;
    concurrency: number;
    endpoints: Array<{ name: string; events: string[]; enabled: boolean }>;
  } | null> {
    const { getWebhookByName } = await import("../webhook/registry.js");
    const d = getWebhookByName(name);
    if (!d) return null;

    const instance = await Storage.get<any>("webhook_instances", name);
    const endpoints = Array.isArray(d.endpoints) ? d.endpoints : [];

    return {
      name: d.name,
      enabled: instance?.enabled ?? true,
      version: d.version ?? 0,
      method: d.method ?? "POST",
      timeout: d.timeout ?? 30000,
      concurrency: d.concurrency ?? 10,
      endpoints: endpoints.map((ep: any) => ({
        name: ep.name,
        events: ep.events ?? [],
        enabled: ep.enabled ?? true,
      })),
    };
  }

  /** Query webhook delivery jobs for a specific dispatcher */
  async getWebhookDeliveries(
    dispatcherName: string,
    opts?: { status?: string; limit?: number; offset?: number },
  ): Promise<{ jobs: OqronJob[]; total: number }> {
    const filter: JobFilter = {
      type: "webhook" as JobType,
      queueName: dispatcherName,
      status: opts?.status as JobStatus | undefined,
      limit: opts?.limit ?? 50,
      offset: opts?.offset ?? 0,
    };
    return this.queryJobs(filter);
  }

  /** Pause a webhook dispatcher */
  async pauseWebhookDispatcher(name: string): Promise<boolean> {
    const engine = this.getWebhookEngine();
    if (!engine || typeof engine.pauseDispatcher !== "function") return false;
    await engine.pauseDispatcher(name);
    return true;
  }

  /** Resume a webhook dispatcher */
  async resumeWebhookDispatcher(name: string): Promise<boolean> {
    const engine = this.getWebhookEngine();
    if (!engine || typeof engine.resumeDispatcher !== "function") return false;
    await engine.resumeDispatcher(name);
    return true;
  }

  /** Resend a failed/DLQ webhook job */
  async resendWebhookJob(jobId: string): Promise<string | null> {
    const engine = this.getWebhookEngine();
    if (!engine || typeof engine.resendJob !== "function") return null;
    return engine.resendJob(jobId);
  }
}
