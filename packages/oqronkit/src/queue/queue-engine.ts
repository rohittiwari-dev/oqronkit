import { randomUUID } from "node:crypto";
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
import type { QueueModuleDef } from "../modules.js";
import {
  deregisterQueue,
  getRegisteredQueues,
  registerQueue as registryRegister,
} from "./registry.js";
import type { QueueConfig } from "./types.js";

export class QueueEngine implements IOqronModule {
  public readonly name = "queue";
  public enabled = true;
  private running = false;
  private timers: NodeJS.Timeout[] = [];
  private workerIdStr = randomUUID();
  /** All active job promises — used for drain during shutdown */
  private activeJobs = new Map<string, Promise<void>>();
  /** Per-queue active job tracking — ensures concurrency is isolated per queue */
  private activeJobsByQueue = new Map<string, Set<string>>();
  private isPolling = new Set<string>();
  /** Active heartbeat workers keyed by job ID — for crash-safe lock renewal */
  private heartbeats = new Map<string, HeartbeatWorker>();
  /** AbortControllers keyed by job ID — for mid-execution cancellation */
  private abortControllers = new Map<string, AbortController>();
  /** Stall detector — reclaims jobs whose heartbeat locks have expired */
  private stallDetector: StallDetector | null = null;
  /** Per-queue pause state — when true, poll is skipped for that queue */
  private pausedQueues = new Set<string>();
  /** Per-queue timers for cleanup on deregister */
  private queueTimers = new Map<string, NodeJS.Timeout>();
  /** Cross-node stall scanner — recovers orphaned jobs from crashed nodes */
  private crossNodeScanner: CrossNodeStallScanner | null = null;
  /** Event-loop lag monitor — pauses job claiming when CPU is stalled */
  private lagMonitor: LagMonitor | null = null;
  /** Storage-broker reconciliation engine — recovers orphaned jobs from split-brain crashes */
  private reconciler: ReconciliationEngine | null = null;

  constructor(
    private config: OqronConfig,
    private logger: Logger,
    private queueConfig?: QueueModuleDef,
    private container?: OqronContainer,
  ) {}

  private get di(): OqronContainer {
    return this.container ?? OqronContainer.get();
  }

  async init(): Promise<void> {
    const qs = getRegisteredQueues();
    this.logger.info(`Initialized QueueEngine covering ${qs.length} endpoints`);

    // Version-based config migration for queue instances
    for (const q of qs) {
      const codeVersion = q.version ?? 0;
      const existing = await this.di.storage.get<any>(
        "queue_instances",
        q.name,
      );
      const dbVersion = existing?.version ?? 0;

      // Downgrade protection — don't overwrite newer DB state with older code
      if (existing && codeVersion < dbVersion) {
        this.logger.warn("Code version is older than DB — skipping overwrite", {
          name: q.name,
          codeVersion,
          dbVersion,
        });
      } else if (existing && codeVersion > dbVersion) {
        this.logger.info("Queue config version upgraded", {
          name: q.name,
          from: dbVersion,
          to: codeVersion,
        });
        await this.di.storage.save("queue_instances", q.name, {
          ...(existing || {}),
          version: codeVersion,
          enabled: existing.enabled ?? true,
        });
        OqronEventBus.emit(
          "queue:version-upgraded",
          q.name,
          dbVersion,
          codeVersion,
        );
      } else if (!existing) {
        // First registration — seed the instance record
        await this.di.storage.save("queue_instances", q.name, {
          version: codeVersion,
          enabled: q.status !== "paused",
        });
      }

      // Load persisted pause state into memory
      const instanceState = await this.di.storage.get<any>(
        "queue_instances",
        q.name,
      );
      if (instanceState && instanceState.enabled === false) {
        this.pausedQueues.add(q.name);
      }
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const qs = getRegisteredQueues();
    for (const q of qs) {
      this.startPolling(q);
    }

    // Start stall detector — checks for jobs whose heartbeat locks have expired
    const stalledInterval = this.queueConfig?.stalledInterval ?? 30000;

    this.stallDetector = new StallDetector(
      this.di.lock,
      this.logger,
      stalledInterval,
    );
    this.stallDetector.start(
      () =>
        Array.from(this.heartbeats.entries()).map(([jobId, _hb]) => ({
          key: `queue:job:${jobId}`,
          ownerId: this.workerIdStr,
        })),
      (key: string) => {
        // Extract jobId from lock key
        const jobId = key.replace("queue:job:", "");
        this.logger.warn(
          `Stall detected for Queue job ${jobId} — nacking back to broker`,
        );
        this.heartbeats.get(jobId)?.stop();
        this.heartbeats.delete(jobId);
        // Find the queue name for nack by scanning per-queue tracking maps
        let queueName: string | undefined;
        for (const [name, jobs] of this.activeJobsByQueue.entries()) {
          if (jobs.has(jobId)) {
            queueName = name;
            break;
          }
        }
        if (queueName) {
          // Increment stalledCount and update telemetry before returning to broker
          this.di.storage
            .get<any>("jobs", jobId)
            .then(async (job) => {
              if (job) {
                job.stalledCount = (job.stalledCount ?? 0) + 1;
                job.attemptMade = (job.attemptMade ?? 0) + 1;
                if (!job.timeline) job.timeline = [];
                job.timeline.push({
                  ts: new Date(),
                  from: job.status,
                  to: "stalled",
                  reason: `Worker lock expired. Re-enqueuing.`,
                });
                job.status = "stalled";
                try {
                  await this.di.storage.save("jobs", jobId, job);
                } catch (e) {
                  this.logger.error("Failed to commit stall telemetry", {
                    jobId,
                    error: String(e),
                  });
                }

                // Check maxStalledCount — fail permanently if exceeded
                const maxStalled =
                  this.queueConfig?.maxStalledCount ??
                  (typeof this.queueConfig?.crossNodeStallScanner === "object"
                    ? this.queueConfig.crossNodeStallScanner.maxStalledCount
                    : undefined) ??
                  3;
                if (job.stalledCount >= maxStalled) {
                  this.logger.error(
                    `Job ${jobId} exceeded maxStalledCount (${maxStalled}) — failing permanently`,
                    { jobId, stalledCount: job.stalledCount },
                  );
                  job.status = "failed";
                  job.error = `Max stall count exceeded (${maxStalled})`;
                  job.finishedAt = new Date();
                  job.timeline.push({
                    ts: new Date(),
                    from: "stalled",
                    to: "failed",
                    reason: job.error,
                  });
                  await this.di.storage.save("jobs", jobId, job);
                  await this.di.broker.ack(queueName!, jobId);
                  OqronEventBus.emit(
                    "job:fail",
                    queueName!,
                    jobId,
                    new Error(job.error),
                  );
                  return;
                }
              }
            })
            .then(() => {
              OqronEventBus.emit("job:stalled", queueName!, jobId);
              void this.di.broker.nack(queueName, jobId);
            });
        }
      },
    );

    // Start cross-node stall scanner — recovers orphaned jobs from crashed nodes
    const scannerConfig = this.queueConfig?.crossNodeStallScanner;
    if (scannerConfig) {
      const scannerOpts =
        typeof scannerConfig === "object" ? scannerConfig : {};
      this.crossNodeScanner = new CrossNodeStallScanner(
        this.di.storage,
        this.di.lock,
        this.logger,
        {
          intervalMs: scannerOpts.intervalMs ?? 60_000,
          lockPrefix: "queue",
          maxStalledCount: scannerOpts.maxStalledCount ?? 3,
        },
      );
      this.crossNodeScanner.start(async (job) => {
        OqronEventBus.emit("job:stalled", job.queueName, job.id);
        if (job.status !== "failed") {
          // Re-queue for retry
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
    const lagConfig = this.queueConfig?.lagMonitor;
    if (lagConfig) {
      this.lagMonitor = new LagMonitor(
        this.logger,
        lagConfig.maxLagMs ?? 500,
        lagConfig.sampleIntervalMs ?? 50,
      );
      this.lagMonitor.start();
    }

    // Start storage-broker reconciliation engine
    const reconConfig = this.queueConfig?.reconciliation;
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

  async triggerManual(id: string): Promise<boolean> {
    const q = getRegisteredQueues().find((q) => q.name === id);
    if (q) {
      await this.poll(q);
      return true;
    }
    return false;
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

    // Clean up per-queue and global active job tracking
    this.activeJobs.delete(jobId);
    for (const jobs of this.activeJobsByQueue.values()) {
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

    // Stop stall detector
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
      this.logger.info(
        `QueueEngine draining ${allActive.length} active jobs...`,
      );
      const timeout = this.queueConfig?.shutdownTimeout ?? 25000;
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
      await hb.stop();
    }
    this.heartbeats.clear();
  }

  // ── Dynamic CRUD Management Methods ────────────────────────────────────

  /**
   * Dynamically register a new queue at runtime.
   * Adds to registry, starts polling if handler present.
   */
  registerQueue(config: QueueConfig): void {
    registryRegister(config);
    if (this.running && config.handler) {
      this.startPolling(config);
    }
    OqronEventBus.emit("queue:registered", config.name);
    this.logger.info(`Queue "${config.name}" dynamically registered`);
  }

  /**
   * Remove a queue from the registry. Does NOT drain active jobs.
   */
  deregisterQueue(name: string): boolean {
    const timer = this.queueTimers.get(name);
    if (timer) {
      clearInterval(timer);
      this.queueTimers.delete(name);
    }
    const removed = deregisterQueue(name);
    if (removed) {
      OqronEventBus.emit("queue:deregistered", name);
      this.logger.info(`Queue "${name}" dynamically deregistered`);
    }
    return removed;
  }

  /**
   * Pause a queue — stops claiming new jobs but keeps active jobs running.
   */
  async pauseQueue(name: string): Promise<void> {
    this.pausedQueues.add(name);
    // Read-modify-write to preserve existing metadata (version, createdAt, etc.)
    const existing = await this.di.storage.get<any>("queue_instances", name);
    await this.di.storage.save("queue_instances", name, {
      ...(existing || {}),
      enabled: false,
    });
    OqronEventBus.emit("queue:paused", name);
    this.logger.info(`Queue "${name}" paused`);
  }

  /**
   * Resume a paused queue — re-enables job claiming.
   */
  async resumeQueue(name: string): Promise<void> {
    this.pausedQueues.delete(name);
    // Read-modify-write to preserve existing metadata (version, createdAt, etc.)
    const existing = await this.di.storage.get<any>("queue_instances", name);
    await this.di.storage.save("queue_instances", name, {
      ...(existing || {}),
      enabled: true,
    });
    // Safety cap to prevent unbounded loop in edge cases
    let batchCount = 0;
    while (batchCount < 20) {
      batchCount++;
      const batch = await this.di.storage.list<OqronJob>(
        "jobs",
        {
          queueName: name,
          status: "paused",
          pausedReason: "disabled-hold",
        },
        { limit: 100 },
      );
      if (batch.length === 0) break;
      for (const held of batch) {
        held.status = "waiting";
        held.pausedReason = undefined;
        await this.di.storage.save("jobs", held.id, held);
        await this.di.broker.publish(
          name,
          held.id,
          undefined,
          held.opts?.priority,
        );
      }
    }
    OqronEventBus.emit("queue:resumed", name);
    this.logger.info(`Queue "${name}" resumed`);
  }

  /**
   * Get the current state of a specific queue.
   */
  getQueueState(name: string):
    | {
        name: string;
        enabled: boolean;
        activeJobs: number;
        strategy: string;
      }
    | undefined {
    const q = getRegisteredQueues().find((q) => q.name === name);
    if (!q) return undefined;
    return {
      name: q.name,
      enabled: !this.pausedQueues.has(name),
      activeJobs: this.activeJobsByQueue.get(name)?.size ?? 0,
      strategy: q.strategy ?? "fifo",
    };
  }

  /**
   * List state for all registered queues.
   */
  listQueues(): Array<{
    name: string;
    enabled: boolean;
    activeJobs: number;
    strategy: string;
  }> {
    return getRegisteredQueues().map((q) => ({
      name: q.name,
      enabled: !this.pausedQueues.has(q.name),
      activeJobs: this.activeJobsByQueue.get(q.name)?.size ?? 0,
      strategy: q.strategy ?? "fifo",
    }));
  }

  private startPolling(q: QueueConfig) {
    // Publisher-only queues have no handler and no processBatch — skip polling entirely.
    // These queues only push jobs; a separate Worker node consumes them.
    if (!q.handler && !q.processBatch) {
      this.logger.info(
        `Queue "${q.name}" has no handler — running in publisher-only mode (no polling)`,
      );
      return;
    }

    const basePollMs =
      q.pollIntervalMs ??
      q.heartbeatMs ??
      this.queueConfig?.heartbeatMs ??
      5000;
    // Add random jitter to prevent thundering herd on multi-worker startup
    const jitter = q.jitterMs ? Math.round(Math.random() * q.jitterMs) : 0;
    const pollIntervalMs = basePollMs + jitter;
    const t = setInterval(() => {
      this.poll(q).catch((e) =>
        this.logger.error(`Queue poller crashed for ${q.name}`, e),
      );
    }, pollIntervalMs);
    t.unref();
    this.timers.push(t);
    this.queueTimers.set(q.name, t);
    setTimeout(() => this.poll(q), 0);
  }

  private async poll(q: QueueConfig): Promise<void> {
    if (!this.running || !this.enabled) return;
    if (this.pausedQueues.has(q.name)) return;
    if (this.isPolling.has(q.name)) return;
    // Circuit breaker: skip polling if event loop is stalled
    if (this.lagMonitor?.isCircuitTripped) return;

    this.isPolling.add(q.name);
    try {
      const concurrency = q.concurrency ?? this.queueConfig?.concurrency ?? 5;
      const lockTtlMs = q.lockTtlMs ?? this.queueConfig?.lockTtlMs ?? 30000;

      // Per-queue concurrency: count only active jobs for THIS queue, not all queues
      const activeForQueue = this.activeJobsByQueue.get(q.name)?.size ?? 0;
      const freeSlots = concurrency - activeForQueue;
      if (freeSlots <= 0) return;

      // Claim IDs from Broker with ordering strategy
      const strategy: BrokerStrategy =
        q.strategy ?? this.queueConfig?.strategy ?? "fifo";

      // Compute claim limit — respect batchSize for batch mode
      const batchSize = q.batchSize ?? 10;
      const limit = q.processBatch ? Math.min(freeSlots, batchSize) : freeSlots;

      // Use blocking claims when available for lower latency
      let jobIds: string[] = [];
      const blockingTimeoutMs =
        q.blockingTimeoutMs ??
        q.pollIntervalMs ??
        q.heartbeatMs ??
        this.queueConfig?.heartbeatMs ??
        5000;

      if (this.di.broker.claimBlocking) {
        const firstId = await this.di.broker.claimBlocking(
          q.name,
          this.workerIdStr,
          lockTtlMs,
          blockingTimeoutMs,
          strategy,
        );
        if (firstId) {
          jobIds.push(firstId);
          // Claim remaining slots non-blocking
          if (limit > 1) {
            const rest = await this.di.broker.claim(
              q.name,
              this.workerIdStr,
              limit - 1,
              lockTtlMs,
              strategy,
            );
            jobIds.push(...rest);
          }
        }
      } else {
        jobIds = await this.di.broker.claim(
          q.name,
          this.workerIdStr,
          limit,
          lockTtlMs,
          strategy,
        );
      }

      if (jobIds.length === 0) return;

      // Fetch job data & validate
      const validJobs: OqronJob[] = [];
      for (const id of jobIds) {
        const raw = await this.di.storage.get("jobs", id);
        if (!raw) {
          // Orphan in broker — ack to eliminate
          await this.di.broker.ack(q.name, id);
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
          await this.di.broker.nack(q.name, id);
          continue;
        }

        validJobs.push(job);
      }

      if (validJobs.length === 0) return;

      // Track in per-queue active set
      if (!this.activeJobsByQueue.has(q.name)) {
        this.activeJobsByQueue.set(q.name, new Set());
      }
      const activeSet = this.activeJobsByQueue.get(q.name)!;
      validJobs.forEach((j) => activeSet.add(j.id));

      // Emit claimed metrics for telemetry
      validJobs.forEach((j) =>
        OqronEventBus.emit("queue:job:claimed", q.name, j.id),
      );

      // Branch to batch or single execution path
      const startTs = Date.now();

      if (q.processBatch && validJobs.length > 0) {
        // Batch execution path
        const p = this.delegateExecuteBatch(validJobs, q)
          .then(async () => {
            const durationMs = Date.now() - startTs;
            await Promise.all(
              validJobs.map((j) =>
                this.emitExecutionMetric(q.name, j.id, durationMs),
              ),
            );
          })
          .catch(() => {
            const durationMs = Date.now() - startTs;
            validJobs.forEach((j) =>
              OqronEventBus.emit("queue:job:failed", q.name, j.id, durationMs),
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
          const p = this.delegateExecuteJob(job, q)
            .then(() => {
              const durationMs = Date.now() - startTs;
              return this.emitExecutionMetric(q.name, job.id, durationMs);
            })
            .catch(() => {
              const durationMs = Date.now() - startTs;
              OqronEventBus.emit(
                "queue:job:failed",
                q.name,
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
      this.isPolling.delete(q.name);
    }
  }

  private async emitExecutionMetric(
    queueName: string,
    jobId: string,
    durationMs: number,
  ): Promise<void> {
    const job = await this.di.storage.get<OqronJob>("jobs", jobId);
    if (job?.status === "completed") {
      OqronEventBus.emit("queue:job:completed", queueName, jobId, durationMs);
    } else if (job?.status === "failed") {
      OqronEventBus.emit("queue:job:failed", queueName, jobId, durationMs);
    }
  }

  /**
   * Delegates to the shared JobExecutor, which handles heartbeat, context,
   * handler invocation, retry/nack/DLQ, finalization, hooks, and pruning.
   */
  private async delegateExecuteJob(
    job: OqronJob,
    q: QueueConfig,
  ): Promise<void> {
    if (!q.handler && !q.processBatch) return; // Safety guard

    const handlerConfig: JobHandlerConfig = {
      name: q.name,
      handler: q.handler,
      processBatch: q.processBatch,
      guaranteedWorker: q.guaranteedWorker,
      heartbeatMs: q.heartbeatMs,
      lockTtlMs: q.lockTtlMs,
      timeout: q.timeout,
      tags: q.tags,
      retries: q.retries,
      rateLimiter: q.rateLimiter,
      deadLetter: q.deadLetter,
      hooks: q.hooks,
      condition: q.condition,
      removeOnComplete:
        q.removeOnComplete ?? keepHistoryToRemoveConfig(q.keepHistory),
      removeOnFail:
        q.removeOnFail ?? keepHistoryToRemoveConfig(q.keepFailedHistory),
    };

    const execCtx: JobExecutionContext = {
      di: this.di,
      logger: this.logger,
      workerId: this.workerIdStr,
      environment: this.config.environment ?? "default",
      project: this.config.project ?? "default",
      handlerConfig,
      moduleDefaults: this.queueConfig ?? {},
      heartbeats: this.heartbeats,
      abortControllers: this.abortControllers,
      lockPrefix: "queue",
    };

    await executeJob(job, execCtx);
  }

  /**
   * Delegates batch of jobs to the shared executeBatch().
   */
  private async delegateExecuteBatch(
    jobs: OqronJob[],
    q: QueueConfig,
  ): Promise<void> {
    if (!q.processBatch) return;

    const handlerConfig: JobHandlerConfig = {
      name: q.name,
      processBatch: q.processBatch,
      guaranteedWorker: q.guaranteedWorker,
      heartbeatMs: q.heartbeatMs,
      lockTtlMs: q.lockTtlMs,
      timeout: q.timeout,
      tags: q.tags,
      retries: q.retries,
      rateLimiter: q.rateLimiter,
      deadLetter: q.deadLetter,
      hooks: q.hooks,
      condition: q.condition,
      removeOnComplete:
        q.removeOnComplete ?? keepHistoryToRemoveConfig(q.keepHistory),
      removeOnFail:
        q.removeOnFail ?? keepHistoryToRemoveConfig(q.keepFailedHistory),
    };

    const execCtx: JobExecutionContext = {
      di: this.di,
      logger: this.logger,
      workerId: this.workerIdStr,
      environment: this.config.environment ?? "default",
      project: this.config.project ?? "default",
      handlerConfig,
      moduleDefaults: this.queueConfig ?? {},
      heartbeats: this.heartbeats,
      abortControllers: this.abortControllers,
      lockPrefix: "queue",
    };

    await executeBatch(jobs, execCtx);
  }
}
