import { randomUUID } from "node:crypto";
import { ThrottleGate } from "../engine/utils/throttle-gate.js";
import type { IOqronModule, Logger } from "../engine/index.js";
import { OqronContainer, OqronEventBus } from "../engine/index.js";
import { LagMonitor } from "../engine/lag-monitor.js";
import { CrossNodeStallScanner } from "../engine/lock/cross-node-stall-scanner.js";
import type { HeartbeatWorker } from "../engine/lock/heartbeat-worker.js";
import { StallDetector } from "../engine/lock/stall-detector.js";
import type { OqronConfig } from "../engine/types/config.types.js";
import type { BrokerStrategy } from "../engine/types/engine.js";
import type { OqronJob } from "../engine/types/job.types.js";
import {
  executeBatch,
  executeJob,
  type JobExecutionContext,
  type JobHandlerConfig,
} from "../engine/utils/job-executor.js";
import { keepHistoryToRemoveConfig } from "../engine/utils/job-retention.js";
import { ReconciliationEngine } from "../engine/utils/reconciliation-engine.js";
import type { WorkerModuleDef } from "../modules.js";
import { getRegisteredQueues } from "../queue/registry.js";
import {
  deregisterWorker,
  getRegisteredWorkers,
  registerWorker as registryRegister,
} from "./registry.js";
import type { WorkerConfig } from "./types.js";

export class WorkerEngine implements IOqronModule {
  public readonly name = "worker";
  public enabled = true;
  private running = false;
  private readonly workerIdStr = randomUUID();
  private activeJobs = new Map<string, Promise<void>>();
  private activeJobsByTopic = new Map<string, Set<string>>();
  private isPolling = new Set<string>();
  private abortControllers = new Map<string, AbortController>();
  private heartbeats = new Map<string, HeartbeatWorker>();
  private stallDetector: StallDetector | null = null;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  /** Per-topic pause state — when true, poll is skipped for that topic */
  private pausedTopics = new Set<string>();
  /** Per-topic timers for cleanup on deregister */
  private topicTimers = new Map<string, NodeJS.Timeout>();
  /** Cross-node stall scanner — recovers orphaned jobs from crashed nodes */
  private crossNodeScanner: CrossNodeStallScanner | null = null;
  /** Event-loop lag monitor — pauses job claiming when CPU is stalled */
  private lagMonitor: LagMonitor | null = null;
  /** Storage-broker reconciliation engine — recovers orphaned jobs from split-brain crashes */
  private reconciler: ReconciliationEngine | null = null;
  /** Per-topic throttle gates — caps dispatch rate per time window */
  private throttleGates = new Map<string, ThrottleGate>();

  constructor(
    private readonly config: OqronConfig,
    private readonly logger: Logger,
    private readonly workerModuleConfig: WorkerModuleDef,
  ) {}

  private get di() {
    return OqronContainer.get();
  }

  async init(): Promise<void> {
    const ws = getRegisteredWorkers();
    this.logger.info(`Initialized WorkerEngine covering ${ws.length} topics`);
    this.warnForSharedConsumerTopics(ws);

    // Version-based config migration for worker instances
    for (const w of ws) {
      const codeVersion = w.version ?? 0;
      const existing = await this.di.storage.get<any>(
        "worker_instances",
        w.topic,
      );
      const dbVersion = existing?.version ?? 0;

      // Downgrade protection — don't overwrite newer DB state with older code
      if (existing && codeVersion < dbVersion) {
        this.logger.warn("Code version is older than DB — skipping overwrite", {
          topic: w.topic,
          codeVersion,
          dbVersion,
        });
      } else if (existing && codeVersion > dbVersion) {
        this.logger.info("Worker config version upgraded", {
          topic: w.topic,
          from: dbVersion,
          to: codeVersion,
        });
        await this.di.storage.save("worker_instances", w.topic, {
          ...(existing || {}),
          version: codeVersion,
          enabled: existing.enabled ?? true,
        });
        OqronEventBus.emit(
          "worker:version-upgraded",
          w.topic,
          dbVersion,
          codeVersion,
        );
      } else if (!existing) {
        // First registration — seed the instance record
        await this.di.storage.save("worker_instances", w.topic, {
          version: codeVersion,
          enabled: w.status !== "paused",
        });
      }

      // Load persisted pause state into memory
      const instanceState = await this.di.storage.get<any>(
        "worker_instances",
        w.topic,
      );
      if (instanceState && instanceState.enabled === false) {
        this.pausedTopics.add(w.topic);
      }
    }
  }

  private warnForSharedConsumerTopics(workers: WorkerConfig[]): void {
    const selfHandlerTopics = new Set(
      getRegisteredQueues()
        .filter((q) => q.handler || q.processBatch)
        .map((q) => q.name),
    );
    const conflicts = [
      ...new Set(
        workers
          .map((w) => w.topic)
          .filter((topic) => selfHandlerTopics.has(topic)),
      ),
    ];

    if (conflicts.length === 0) return;

    this.logger.warn(
      "Worker topic also has a self-handler queue; both engines may compete for the same broker jobs.",
      { topics: conflicts },
    );
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    for (const w of getRegisteredWorkers()) {
      this.startPolling(w);
    }

    // Stall detection runs universally for all guaranteed workers
    this.stallDetector = new StallDetector(
      this.di.lock,
      this.logger,
      this.workerModuleConfig.stalledInterval ?? 30000,
    );

    this.stallDetector.start(
      () => {
        const active: Array<{ key: string; ownerId: string }> = [];
        for (const [jobId] of this.heartbeats.entries()) {
          // Include all tracked heartbeats — even inactive ones whose lock
          // renewal failed — so the stall detector can trigger recovery.
          active.push({
            key: `worker:job:${jobId}`,
            ownerId: this.workerIdStr,
          });
        }
        return active;
      },
      async (key) => {
        const jobId = key.replace("worker:job:", "");
        await this.handleStalledJob(jobId);
      },
    );

    // Start cross-node stall scanner — recovers orphaned jobs from crashed nodes
    const scannerConfig = this.workerModuleConfig?.crossNodeStallScanner;
    if (scannerConfig) {
      const scannerOpts =
        typeof scannerConfig === "object" ? scannerConfig : {};
      this.crossNodeScanner = new CrossNodeStallScanner(
        this.di.storage,
        this.di.lock,
        this.logger,
        {
          intervalMs: scannerOpts.intervalMs ?? 60_000,
          lockPrefix: "worker",
          maxStalledCount: scannerOpts.maxStalledCount ?? 3,
        },
      );
      this.crossNodeScanner.start(async (job) => {
        OqronEventBus.emit("job:stalled", job.queueName, job.id);
        if (job.status !== "failed") {
          if (job.opts?.priority !== undefined) {
            await this.di.broker.nack(
              job.queueName,
              job.id,
              undefined,
              job.opts.priority,
            );
          } else {
            await this.di.broker.nack(job.queueName, job.id);
          }
        }
      });
    }

    // Start event-loop lag monitor
    const lagConfig = this.workerModuleConfig?.lagMonitor;
    if (lagConfig) {
      this.lagMonitor = new LagMonitor(
        this.logger,
        lagConfig.maxLagMs ?? 500,
        lagConfig.sampleIntervalMs ?? 50,
      );
      this.lagMonitor.start();
    }

    // Start storage-broker reconciliation engine
    const reconConfig = this.workerModuleConfig?.reconciliation;
    if (reconConfig) {
      const reconOpts = typeof reconConfig === "object" ? reconConfig : {};
      this.reconciler = new ReconciliationEngine(
        this.di.storage,
        this.di.broker,
        this.di.lock,
        this.logger,
        {
          intervalMs: reconOpts.intervalMs ?? 120_000,
          waitingThresholdMs: reconOpts.waitingThresholdMs ?? 300_000,
          delayedGraceMs: reconOpts.delayedGraceMs ?? 120_000,
          batchSize: reconOpts.batchSize ?? 500,
        },
      );
      this.reconciler.start();
    }
  }

  async enable(): Promise<void> {
    this.enabled = true;
    if (!this.running) {
      await this.start();
    }
  }

  async disable(): Promise<void> {
    this.enabled = false;
  }

  async triggerManual(id: string): Promise<boolean> {
    const w = getRegisteredWorkers().find((cw) => cw.topic === id);
    if (w) {
      await this.poll(w);
      return true;
    }
    return false;
  }

  /**
   * Cancel an actively running job via AbortController.
   * Aborts the handler, stops the heartbeat, and marks the job as failed.
   */
  async cancelActiveJob(jobId: string): Promise<boolean> {
    const controller = this.abortControllers.get(jobId);
    if (!controller) return false;

    controller.abort();
    this.abortControllers.delete(jobId);

    // Stop heartbeat
    const hb = this.heartbeats.get(jobId);
    if (hb) {
      await hb.stop();
      this.heartbeats.delete(jobId);
    }

    // Clean up per-topic and global active job tracking
    this.activeJobs.delete(jobId);
    for (const jobs of this.activeJobsByTopic.values()) {
      jobs.delete(jobId);
    }

    // Mark job as cancelled for explicit user-initiated cancellation
    const job = await this.di.storage.get<OqronJob>("jobs", jobId);
    if (job) {
      job.status = "cancelled";
      job.error = "Cancelled";
      job.finishedAt = new Date();
      await this.di.storage.save("jobs", jobId, job);

      // Ack from broker so it's not re-processed
      await this.di.broker.ack(job.queueName, jobId);
      OqronEventBus.emit("job:cancelled", job.queueName, jobId);
    }

    return true;
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];

    this.stallDetector?.stop();
    this.stallDetector = null;

    // Stop cross-node scanner
    this.crossNodeScanner?.stop();
    this.crossNodeScanner = null;

    // Stop lag monitor
    this.lagMonitor?.stop();
    this.lagMonitor = null;

    // Stop reconciliation engine
    this.reconciler?.stop();
    this.reconciler = null;

    // Abort all active jobs
    for (const controller of this.abortControllers.values()) {
      controller.abort();
    }
    this.abortControllers.clear();

    // Drain active jobs first — heartbeats must stay alive to prevent re-claims during drain
    const allActive = Array.from(this.activeJobs.values());
    if (allActive.length > 0) {
      const timeout = this.workerModuleConfig.shutdownTimeout ?? 25_000;
      await Promise.race([
        Promise.allSettled(allActive),
        new Promise((r) => {
          const h = setTimeout(r, timeout);
          h.unref();
        }),
      ]);
    }

    // THEN stop heartbeats and release locks
    for (const hb of this.heartbeats.values()) {
      await hb.stop().catch(() => {});
    }
    this.heartbeats.clear();
  }

  // ── Dynamic CRUD Management Methods ────────────────────────────────────

  /**
   * Dynamically register a new worker at runtime.
   * Adds to registry, starts polling.
   */
  registerWorker(config: WorkerConfig): void {
    registryRegister(config);
    if (this.running) {
      this.startPolling(config);
    }
    OqronEventBus.emit("worker:registered", config.topic);
    this.logger.info(`Worker "${config.topic}" dynamically registered`);
  }

  /**
   * Remove a worker from the registry. Does NOT drain active jobs.
   */
  deregisterWorker(topic: string): boolean {
    const timer = this.topicTimers.get(topic);
    if (timer) {
      clearInterval(timer);
      this.topicTimers.delete(topic);
    }
    const removed = deregisterWorker(topic);
    if (removed) {
      OqronEventBus.emit("worker:deregistered", topic);
      this.logger.info(`Worker "${topic}" dynamically deregistered`);
    }
    return removed;
  }

  /**
   * Pause a worker — stops claiming new jobs for this topic.
   * Persists state to storage for crash-safety.
   */
  async pauseWorker(topic: string): Promise<void> {
    this.pausedTopics.add(topic);
    const existing = await this.di.storage.get<any>("worker_instances", topic);
    await this.di.storage.save("worker_instances", topic, {
      ...(existing || {}),
      enabled: false,
    });
    OqronEventBus.emit("worker:paused", topic);
    this.logger.info(`Worker "${topic}" paused`);
  }

  /**
   * Resume a paused worker.
   * Persists state to storage for crash-safety.
   */
  async resumeWorker(topic: string): Promise<void> {
    this.pausedTopics.delete(topic);
    const existing = await this.di.storage.get<any>("worker_instances", topic);
    await this.di.storage.save("worker_instances", topic, {
      ...(existing || {}),
      enabled: true,
    });
    OqronEventBus.emit("worker:resumed", topic);
    this.logger.info(`Worker "${topic}" resumed`);
  }

  /**
   * Get the current state of a specific worker.
   */
  getWorkerState(topic: string):
    | {
        topic: string;
        enabled: boolean;
        activeJobs: number;
        concurrency: number;
      }
    | undefined {
    const w = getRegisteredWorkers().find((cw) => cw.topic === topic);
    if (!w) return undefined;
    return {
      topic: w.topic,
      enabled: !this.pausedTopics.has(topic),
      activeJobs: this.activeJobsByTopic.get(topic)?.size ?? 0,
      concurrency: w.concurrency ?? this.workerModuleConfig.concurrency ?? 5,
    };
  }

  /**
   * List state for all registered workers.
   */
  listWorkers(): Array<{
    topic: string;
    enabled: boolean;
    activeJobs: number;
    concurrency: number;
  }> {
    return getRegisteredWorkers().map((w) => ({
      topic: w.topic,
      enabled: !this.pausedTopics.has(w.topic),
      activeJobs: this.activeJobsByTopic.get(w.topic)?.size ?? 0,
      concurrency: w.concurrency ?? this.workerModuleConfig.concurrency ?? 5,
    }));
  }

  private startPolling(w: WorkerConfig) {
    // Create throttle gate if configured
    if (w.throttle) {
      this.throttleGates.set(w.topic, new ThrottleGate(w.throttle));
    }

    // Use pollIntervalMs if set, fall back to heartbeatMs
    const basePollMs =
      w.pollIntervalMs ??
      w.heartbeatMs ??
      this.workerModuleConfig.heartbeatMs ??
      5000;
    // Add random jitter to prevent thundering herd on multi-worker startup
    const jitter = w.jitterMs ? Math.round(Math.random() * w.jitterMs) : 0;
    const pollIntervalMs = basePollMs + jitter;
    const t = setInterval(() => {
      this.poll(w).catch((e) =>
        this.logger.error("Worker poll error", {
          topic: w.topic,
          err: String(e),
        }),
      );
    }, pollIntervalMs);
    t.unref();
    this.timers.push(t);
    this.topicTimers.set(w.topic, t);
    // Immediate first poll so jobs don't wait a full poll interval
    setTimeout(() => this.poll(w), 0);
  }

  private async poll(w: WorkerConfig): Promise<void> {
    if (!this.running || !this.enabled) return;
    if (this.pausedTopics.has(w.topic)) {
      if (w.disabledBehavior === "skip") {
        await this.flushTopic(w.topic);
      }
      return;
    }
    if (this.isPolling.has(w.topic)) return;
    // Circuit breaker: skip polling if event loop is stalled
    if (this.lagMonitor?.isCircuitTripped) return;

    this.isPolling.add(w.topic);
    try {
      const concurrency =
        w.concurrency ?? this.workerModuleConfig.concurrency ?? 5;
      const currentActive = this.activeJobsByTopic.get(w.topic)?.size ?? 0;
      const freeSlots = concurrency - currentActive;

      if (freeSlots <= 0) return;

      const strategy: BrokerStrategy =
        w.strategy ?? this.workerModuleConfig.strategy ?? "fifo";
      const lockTtlMs =
        w.lockTtlMs ?? this.workerModuleConfig.lockTtlMs ?? 30_000;

      // Compute claim limit — respect batchSize for batch mode
      const batchSize = w.batchSize ?? 10;
      let limit = w.processBatch ? Math.min(freeSlots, batchSize) : freeSlots;

      // Throttle gate: cap limit by available budget in the current window
      const gate = this.throttleGates.get(w.topic);
      if (gate) {
        limit = Math.min(limit, gate.getAvailable());
        if (limit <= 0) return;
      }

      // Use blocking claims when available for lower latency
      let claimedIds: string[] = [];
      const blockingTimeoutMs =
        w.blockingTimeoutMs ??
        w.pollIntervalMs ??
        w.heartbeatMs ??
        this.workerModuleConfig.heartbeatMs ??
        5000;

      if (this.di.broker.claimBlocking) {
        const firstId = await this.di.broker.claimBlocking(
          w.topic,
          this.workerIdStr,
          lockTtlMs,
          blockingTimeoutMs,
          strategy,
        );
        if (firstId) {
          claimedIds.push(firstId);
          // Claim remaining slots non-blocking
          if (limit > 1) {
            const rest = await this.di.broker.claim(
              w.topic,
              this.workerIdStr,
              limit - 1,
              lockTtlMs,
              strategy,
            );
            claimedIds.push(...rest);
          }
        }
      } else {
        // Fallback to active polling
        claimedIds = await this.di.broker.claim(
          w.topic,
          this.workerIdStr,
          limit,
          lockTtlMs,
          strategy,
        );
      }

      if (!claimedIds.length) return;

      // Record dispatched count for throttle gate
      gate?.record(claimedIds.length);

      // Fetch job data & validate
      const validJobs: OqronJob[] = [];
      for (const id of claimedIds) {
        const raw = await this.di.storage.get<OqronJob>("jobs", id);
        if (!raw) {
          // Job in broker but not in DB (orphan), ack to clean it up
          await this.di.broker.ack(w.topic, id);
          continue;
        }
        const job = raw as OqronJob;

        // Verify environment matches (or job has no env bounds)
        if (
          job.environment &&
          this.config.environment &&
          job.environment !== this.config.environment
        ) {
          this.logger.warn(`Returning job ${id} — wrong environment`, {
            jobEnv: job.environment,
            workerEnv: this.config.environment,
          });
          await this.di.broker.nack(w.topic, id);
          continue;
        }

        validJobs.push(job);
      }

      if (validJobs.length === 0) return;

      // Track in per-topic active set
      if (!this.activeJobsByTopic.has(w.topic)) {
        this.activeJobsByTopic.set(w.topic, new Set());
      }
      const activeSet = this.activeJobsByTopic.get(w.topic)!;
      validJobs.forEach((j) => activeSet.add(j.id));

      // Emit claimed metrics for telemetry
      validJobs.forEach((j) =>
        OqronEventBus.emit("worker:job:claimed", w.topic, j.id),
      );

      // Branch to batch or single execution path
      const startTs = Date.now();

      if (w.processBatch && validJobs.length > 0) {
        // Batch execution path
        const p = this.delegateExecuteBatch(validJobs, w)
          .then(async () => {
            const durationMs = Date.now() - startTs;
            await Promise.all(
              validJobs.map((j) =>
                this.emitExecutionMetric(w.topic, j.id, durationMs),
              ),
            );
          })
          .catch(() => {
            const durationMs = Date.now() - startTs;
            validJobs.forEach((j) =>
              OqronEventBus.emit(
                "worker:job:failed",
                w.topic,
                j.id,
                durationMs,
              ),
            );
          })
          .finally(() => {
            validJobs.forEach((j) => {
              this.activeJobs.delete(j.id);
              activeSet.delete(j.id);
            });
          });
        validJobs.forEach((j) => this.activeJobs.set(j.id, p));
      } else {
        // Single execution path
        for (const job of validJobs) {
          const p = this.delegateExecuteJob(job, w)
            .then(() => {
              const durationMs = Date.now() - startTs;
              return this.emitExecutionMetric(w.topic, job.id, durationMs);
            })
            .catch(() => {
              const durationMs = Date.now() - startTs;
              OqronEventBus.emit(
                "worker:job:failed",
                w.topic,
                job.id,
                durationMs,
              );
            })
            .finally(() => {
              this.activeJobs.delete(job.id);
              activeSet.delete(job.id);
            });
          this.activeJobs.set(job.id, p);
        }
      }
    } finally {
      this.isPolling.delete(w.topic);
    }
  }

  private async emitExecutionMetric(
    topic: string,
    jobId: string,
    durationMs: number,
  ): Promise<void> {
    const job = await this.di.storage.get<OqronJob>("jobs", jobId);
    if (job?.status === "completed") {
      OqronEventBus.emit("worker:job:completed", topic, jobId, durationMs);
    } else if (job?.status === "failed") {
      OqronEventBus.emit("worker:job:failed", topic, jobId, durationMs);
    }
  }

  private async handleStalledJob(jobId: string) {
    const raw = await this.di.storage.get<OqronJob>("jobs", jobId);
    if (!raw || raw.status !== "active") return;
    const job = raw;

    if (
      job.project &&
      this.config.project &&
      job.project !== this.config.project
    ) {
      return; // Not our project
    }

    if (!this.enabled) return;

    // Match by moduleName first, fall back to queueName if moduleName is missing
    const w = getRegisteredWorkers().find(
      (cw) => cw.topic === job.moduleName || cw.topic === job.queueName,
    );
    if (!w) return; // We don't have a handler registered for this worker topic

    if (this.pausedTopics.has(w.topic) && w.disabledBehavior === "skip") {
      return;
    }

    const maxStalled = this.workerModuleConfig.maxStalledCount ?? 1;
    const stalledCount = (job.stalledCount ?? 0) + 1;

    if (stalledCount > maxStalled) {
      this.logger.error("Job exceeded max stall retries, failing", {
        jobId,
        stalledCount,
      });
      job.status = "failed";
      job.error = "Max stall retries exceeded (Worker crashed)";
      job.finishedAt = new Date();
      await this.di.storage.save("jobs", jobId, job);
      // Assume it's unacked in broker, or was lost.
      return;
    }

    job.stalledCount = stalledCount;
    job.attemptMade = (job.attemptMade ?? 0) + 1;
    await this.di.storage.save("jobs", jobId, job);

    // Abort the stuck handler and release concurrency slot
    const ac = this.abortControllers.get(jobId);
    if (ac) {
      ac.abort();
      this.abortControllers.delete(jobId);
    }
    this.activeJobs.delete(jobId);
    for (const jobs of this.activeJobsByTopic.values()) {
      jobs.delete(jobId);
    }
    this.heartbeats.get(jobId)?.stop();
    this.heartbeats.delete(jobId);

    this.logger.info("Re-queueing stalled worker job", { jobId });
    OqronEventBus.emit("job:stalled", w.topic, jobId);
    await this.di.broker.nack(w.topic, jobId);
  }

  private async flushTopic(topic: string) {
    const claimed = await this.di.broker.claim(
      topic,
      this.workerIdStr,
      5,
      30_000,
    );
    for (const id of claimed) {
      const job = await this.di.storage.get<OqronJob>("jobs", id);
      if (job) {
        job.status = "failed";
        job.error = "Skipped because worker has disabledBehavior='skip'";
        job.finishedAt = new Date();
        await this.di.storage.save("jobs", job.id, job);
      }
      await this.di.broker.ack(topic, id);
    }
  }

  /**
   * Delegates to the shared JobExecutor, which handles heartbeat, context,
   * handler invocation, retry/nack/DLQ, finalization, hooks, and pruning.
   */
  private async delegateExecuteJob(
    job: OqronJob,
    w: WorkerConfig,
  ): Promise<void> {
    const handlerConfig: JobHandlerConfig = {
      name: w.topic,
      handler: w.handler,
      processBatch: w.processBatch,
      guaranteedWorker: w.guaranteedWorker,
      heartbeatMs: w.heartbeatMs,
      lockTtlMs: w.lockTtlMs,
      timeout: w.timeout,
      tags: w.tags,
      retries: w.retries,
      rateLimiter: w.rateLimiter,
      deadLetter: w.deadLetter,
      hooks: w.hooks,
      condition: w.condition,
      removeOnComplete:
        w.removeOnComplete ?? keepHistoryToRemoveConfig(w.keepHistory),
      removeOnFail:
        w.removeOnFail ?? keepHistoryToRemoveConfig(w.keepFailedHistory),
    };

    const execCtx: JobExecutionContext = {
      di: this.di,
      logger: this.logger,
      workerId: this.workerIdStr,
      environment: this.config.environment ?? "default",
      project: this.config.project ?? "default",
      handlerConfig,
      moduleDefaults: this.workerModuleConfig,
      heartbeats: this.heartbeats,
      abortControllers: this.abortControllers,
      lockPrefix: "worker",
    };

    await executeJob(job, execCtx);
  }

  /**
   * Delegates batch of jobs to the shared executeBatch().
   */
  private async delegateExecuteBatch(
    jobs: OqronJob[],
    w: WorkerConfig,
  ): Promise<void> {
    if (!w.processBatch) return;

    const handlerConfig: JobHandlerConfig = {
      name: w.topic,
      processBatch: w.processBatch,
      guaranteedWorker: w.guaranteedWorker,
      heartbeatMs: w.heartbeatMs,
      lockTtlMs: w.lockTtlMs,
      timeout: w.timeout,
      tags: w.tags,
      retries: w.retries,
      rateLimiter: w.rateLimiter,
      deadLetter: w.deadLetter,
      hooks: w.hooks,
      condition: w.condition,
      removeOnComplete:
        w.removeOnComplete ?? keepHistoryToRemoveConfig(w.keepHistory),
      removeOnFail:
        w.removeOnFail ?? keepHistoryToRemoveConfig(w.keepFailedHistory),
    };

    const execCtx: JobExecutionContext = {
      di: this.di,
      logger: this.logger,
      workerId: this.workerIdStr,
      environment: this.config.environment ?? "default",
      project: this.config.project ?? "default",
      handlerConfig,
      moduleDefaults: this.workerModuleConfig,
      heartbeats: this.heartbeats,
      abortControllers: this.abortControllers,
      lockPrefix: "worker",
    };

    await executeBatch(jobs, execCtx);
  }
}
