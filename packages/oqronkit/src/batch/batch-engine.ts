/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  OqronKit — Batch Engine
 *
 *  Core module engine for the batch accumulator. Implements IOqronModule.
 *
 *  Two loops:
 *  1. Tick Loop — periodically checks buffers and creates flush jobs
 *     (only runs on the leader node in distributed deployments)
 *  2. Poll Loop — claims and executes batch jobs from the broker
 *     (runs on all nodes)
 *
 *  Environment/project isolation is handled by the OqronContainer layer —
 *  all storage/broker/lock calls are automatically prefixed.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { randomUUID } from "node:crypto";
import { OqronContainer } from "../engine/container.js";
import type { Logger } from "../engine/logger/index.js";
import type { OqronConfig } from "../engine/types/config.types.js";
import type { OqronJob } from "../engine/types/job.types.js";
import type { IOqronModule } from "../engine/types/module.types.js";
import {
  keepHistoryToRemoveConfig,
  pruneAfterCompletion,
} from "../engine/utils/job-retention.js";
import { ThrottleGate } from "../engine/utils/throttle-gate.js";
import type { BatchModuleDef } from "../modules.js";
import { applyGlobalTags, getRegisteredBatches } from "./registry.js";
import type {
  BatchBufferRecord,
  BatchConfig,
  BatchJobContext,
  BatchPayload,
} from "./types.js";

export class BatchEngine implements IOqronModule {
  public readonly name = "batch";
  public enabled = true;

  /** Engine state flags */
  private running = false;
  private workerId = randomUUID();

  /** Timer handles for cleanup on stop */
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  /** Active batch job promises keyed by job ID */
  private activeJobs = new Map<string, Promise<void>>();

  /** Paused batch definitions */
  private pausedBatches = new Set<string>();

  /** Per-definition throttle gates */
  private throttleGates = new Map<string, ThrottleGate>();

  /** Leader election state */
  private isLeader = false;
  private leaderTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private config: OqronConfig,
    private logger: Logger,
    private batchConfig?: BatchModuleDef,
  ) {}

  /** DI accessor — resolves OqronContainer singleton */
  private get di(): OqronContainer {
    return OqronContainer.get();
  }

  // ── Config Resolution ─────────────────────────────────────────────────

  private get tickIntervalMs(): number {
    return this.batchConfig?.tickIntervalMs ?? 1_000;
  }

  private get defaultConcurrency(): number {
    return this.batchConfig?.concurrency ?? 1;
  }

  private get heartbeatMs(): number {
    return this.batchConfig?.heartbeatMs ?? 5_000;
  }

  private get lockTtlMs(): number {
    return this.batchConfig?.lockTtlMs ?? 30_000;
  }

  private get shutdownTimeoutMs(): number {
    return this.batchConfig?.shutdownTimeout ?? 25_000;
  }

  private get leaderElection(): boolean {
    return this.batchConfig?.leaderElection !== false;
  }

  // ── IOqronModule Lifecycle ────────────────────────────────────────────

  async init(): Promise<void> {
    // Apply global tags from config
    applyGlobalTags(this.config.tags);

    const defs = getRegisteredBatches();
    this.logger.info(
      `Batch engine initialized with ${defs.length} definition(s)`,
    );

    // Set up throttle gates for definitions that have throttle config
    for (const def of defs) {
      if (def.throttle) {
        this.throttleGates.set(def.name, new ThrottleGate(def.throttle));
      }
      // Apply initial paused state
      if (def.status === "paused") {
        this.pausedBatches.add(def.name);
      }
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Start leader election (if enabled)
    if (this.leaderElection) {
      await this.acquireLeadership();
      this.leaderTimer = setInterval(
        () => void this.acquireLeadership(),
        Math.max(this.lockTtlMs / 3, 5_000),
      );
    } else {
      // No leader election — this node is always the leader
      this.isLeader = true;
    }

    // Start tick loop (buffer evaluation — leader only)
    this.tickTimer = setInterval(() => {
      if (this.isLeader && this.running) {
        void this.tickLoop();
      }
    }, this.tickIntervalMs);

    // Start poll loop (batch job execution — all nodes)
    this.pollTimer = setInterval(() => {
      if (this.running) {
        void this.pollLoop();
      }
    }, this.heartbeatMs);

    this.logger.info("Batch engine started", {
      leader: this.isLeader,
      tickMs: this.tickIntervalMs,
      pollMs: this.heartbeatMs,
    });
  }

  async stop(): Promise<void> {
    this.running = false;

    // Clear timers
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.leaderTimer) clearInterval(this.leaderTimer);
    this.tickTimer = null;
    this.pollTimer = null;
    this.leaderTimer = null;

    // Flush on shutdown if configured
    const defs = getRegisteredBatches();
    for (const def of defs) {
      if (def.flushOnShutdown !== false) {
        try {
          await this.flushAllGroupsForDef(def);
        } catch (err) {
          this.logger.warn(`Failed to flush "${def.name}" on shutdown`, {
            error: String(err),
          });
        }
      }
    }

    // Wait for active jobs to drain
    if (this.activeJobs.size > 0) {
      this.logger.info(
        `Draining ${this.activeJobs.size} active batch job(s)...`,
      );
      const drainPromise = Promise.allSettled(
        Array.from(this.activeJobs.values()),
      );
      const timeout = new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.shutdownTimeoutMs);
        t.unref();
      });
      await Promise.race([drainPromise, timeout]);
    }

    // Release leadership
    if (this.leaderElection) {
      try {
        await this.di.lock.release("batch:leader", this.workerId);
      } catch {
        // Best-effort
      }
    }

    this.logger.info("Batch engine stopped");
  }

  async enable(): Promise<void> {
    this.enabled = true;
    await this.start();
  }

  async disable(): Promise<void> {
    this.enabled = false;
    await this.stop();
  }

  // ── Leader Election ───────────────────────────────────────────────────

  private async acquireLeadership(): Promise<void> {
    try {
      const acquired = await this.di.lock.acquire(
        "batch:leader",
        this.workerId,
        this.lockTtlMs,
      );
      if (acquired) {
        if (!this.isLeader) {
          this.logger.info("Acquired batch leader lock");
        }
        this.isLeader = true;
      } else {
        // Try to renew existing lock
        const renewed = await this.di.lock.renew(
          "batch:leader",
          this.workerId,
          this.lockTtlMs,
        );
        if (!renewed) {
          if (this.isLeader) {
            this.logger.info("Lost batch leader lock");
          }
          this.isLeader = false;
        }
      }
    } catch (err) {
      this.logger.warn("Leader election error", { error: String(err) });
    }
  }

  // ── Tick Loop (Buffer Evaluation) ─────────────────────────────────────

  /**
   * Runs on leader only. Scans all registered batch definitions,
   * checks each group buffer against flush conditions.
   */
  private async tickLoop(): Promise<void> {
    const defs = getRegisteredBatches();
    for (const def of defs) {
      if (this.pausedBatches.has(def.name)) continue;
      try {
        await this.evaluateBuffers(def);
      } catch (err) {
        this.logger.error(`Tick error for "${def.name}"`, {
          error: String(err),
        });
      }
    }
  }

  /**
   * Evaluate all group buffers for a single batch definition.
   * Triggers flush when maxSize or maxWaitMs conditions are met.
   */
  private async evaluateBuffers(def: BatchConfig): Promise<void> {
    const persist = def.persist !== false;
    const now = Date.now();

    if (persist) {
      // Read all buffers for this definition from storage
      const allBuffers = await this.di.storage.list<any>("batch_buffers", {});

      // Filter to buffers belonging to this definition
      const myBuffers = allBuffers.filter((b: any) => {
        const id = b.id ?? b._id ?? "";
        return typeof id === "string" && id.startsWith(`${def.name}:`);
      });

      for (const raw of myBuffers) {
        const id: string = raw.id ?? raw._id ?? "";
        const groupKey = id.substring(def.name.length + 1);
        const buffer = raw as BatchBufferRecord;

        if (!buffer.items || buffer.items.length === 0) continue;

        const shouldFlush =
          buffer.items.length >= def.maxSize ||
          now - buffer.firstItemAt >= def.maxWaitMs;

        if (shouldFlush) {
          await this.flushBuffer(def, groupKey, buffer, id);
        }
      }
    } else {
      // In-memory buffers — check the IBatch proxy's internal map
      // Engine accesses memory buffers via the registry config's _memoryBuffers
      // (set by define-batch.ts)
      const memBuffers = (def as any)._memoryBuffers as
        | Map<string, BatchBufferRecord>
        | undefined;
      if (!memBuffers) return;

      for (const [groupKey, buffer] of memBuffers) {
        if (!buffer.items || buffer.items.length === 0) continue;

        const shouldFlush =
          buffer.items.length >= def.maxSize ||
          now - buffer.firstItemAt >= def.maxWaitMs;

        if (shouldFlush) {
          // Snapshot and clear
          const items = [...buffer.items];
          memBuffers.delete(groupKey);
          await this.createBatchJob(def, groupKey, items);
        }
      }
    }
  }

  /**
   * Flush a persisted buffer: read items, create job, delete buffer.
   */
  private async flushBuffer(
    def: BatchConfig,
    groupKey: string,
    buffer: BatchBufferRecord,
    storageKey: string,
  ): Promise<void> {
    // Throttle check
    const gate = this.throttleGates.get(def.name);
    if (gate && gate.getAvailable() <= 0) {
      return; // Rate limited — skip this tick
    }

    // Backpressure check
    if (def.maxPendingBatches) {
      const pending = await this.di.storage.count("jobs", {
        queueName: `batch:${def.name}`,
        status: "waiting",
      });
      const active = await this.di.storage.count("jobs", {
        queueName: `batch:${def.name}`,
        status: "active",
      });
      if (pending + active >= def.maxPendingBatches) {
        return; // Backpressure — too many pending batches
      }
    }

    let items = [...buffer.items];

    // Apply beforeFlush hook
    if (def.hooks?.beforeFlush) {
      items = await def.hooks.beforeFlush(items, groupKey);
    }

    if (items.length === 0) {
      // Hook filtered everything — clear buffer
      await this.di.storage.delete("batch_buffers", storageKey);
      return;
    }

    // Create the batch job
    await this.createBatchJob(def, groupKey, items);

    // Record the flush in the throttle gate
    if (gate) gate.record(1);

    // Clear the buffer
    await this.di.storage.delete("batch_buffers", storageKey);
  }

  /**
   * Create a batch job and publish it to the broker.
   */
  private async createBatchJob(
    def: BatchConfig,
    groupKey: string,
    items: any[],
  ): Promise<void> {
    const jobId = `batch:${def.name}:${groupKey}:${Date.now()}`;
    const now = new Date();

    const payload: BatchPayload = {
      items,
      groupKey: groupKey !== "default" ? groupKey : undefined,
      bufferCreatedAt: now.getTime(),
      flushedAt: now.getTime(),
    };

    const job: OqronJob<BatchPayload> = {
      id: jobId,
      type: "batch",
      queueName: `batch:${def.name}`,
      data: payload,
      status: "waiting",
      attemptMade: 0,
      progressPercent: 0,
      createdAt: now,
      environment: this.config.environment ?? "development",
      project: this.config.project ?? "default",
      tags: [...(this.config.tags ?? []), ...(def.tags ?? [])],
      opts: {},
    };

    await this.di.storage.save("jobs", jobId, job);
    await this.di.broker.publish(`batch:${def.name}`, jobId);

    this.logger.info(`Flushed batch "${def.name}:${groupKey}"`, {
      items: items.length,
      jobId,
    });
  }

  /** Flush all groups for a definition (used during shutdown). */
  private async flushAllGroupsForDef(def: BatchConfig): Promise<void> {
    const persist = def.persist !== false;

    if (persist) {
      const allBuffers = await this.di.storage.list<any>("batch_buffers", {});
      const myBuffers = allBuffers.filter((b: any) => {
        const id = b.id ?? b._id ?? "";
        return typeof id === "string" && id.startsWith(`${def.name}:`);
      });

      for (const raw of myBuffers) {
        const id: string = raw.id ?? raw._id ?? "";
        const groupKey = id.substring(def.name.length + 1);
        const buffer = raw as BatchBufferRecord;
        if (buffer.items?.length > 0) {
          await this.flushBuffer(def, groupKey, buffer, id);
        }
      }
    } else {
      const memBuffers = (def as any)._memoryBuffers as
        | Map<string, BatchBufferRecord>
        | undefined;
      if (!memBuffers) return;
      for (const [groupKey, buffer] of memBuffers) {
        if (buffer.items?.length > 0) {
          const items = [...buffer.items];
          memBuffers.delete(groupKey);
          await this.createBatchJob(def, groupKey, items);
        }
      }
    }
  }

  // ── Poll Loop (Batch Job Execution) ───────────────────────────────────

  /**
   * Claims batch jobs from the broker and executes handlers.
   * Runs on all nodes (not just leader).
   */
  private async pollLoop(): Promise<void> {
    const defs = getRegisteredBatches();

    for (const def of defs) {
      if (this.pausedBatches.has(def.name)) continue;

      const concurrency = def.concurrency ?? this.defaultConcurrency;
      const activeForDef = this.countActiveForDef(def.name);
      const available = concurrency - activeForDef;

      if (available <= 0) continue;

      try {
        const claimed = await this.di.broker.claim(
          `batch:${def.name}`,
          this.workerId,
          available,
          this.lockTtlMs,
        );

        for (const jobId of claimed) {
          const promise = this.executeJob(def, jobId);
          this.activeJobs.set(jobId, promise);
          promise.finally(() => this.activeJobs.delete(jobId));
        }
      } catch (err) {
        this.logger.error(`Poll error for "${def.name}"`, {
          error: String(err),
        });
      }
    }
  }

  /** Count active jobs for a specific batch definition. */
  private countActiveForDef(defName: string): number {
    let count = 0;
    for (const key of this.activeJobs.keys()) {
      if (key.startsWith(`batch:${defName}:`)) count++;
    }
    return count;
  }

  // ── Job Execution ─────────────────────────────────────────────────────

  /**
   * Execute a single batch job. Follows the same crash-safety patterns
   * as QueueEngine: load job → verify environment → execute handler →
   * ack/nack → retention.
   */
  private async executeJob(def: BatchConfig, jobId: string): Promise<void> {
    const job = await this.di.storage.get<OqronJob<BatchPayload>>(
      "jobs",
      jobId,
    );
    if (!job) {
      await this.di.broker.ack(`batch:${def.name}`, jobId);
      return;
    }

    // Environment isolation check
    if (
      job.environment &&
      job.environment !== (this.config.environment ?? "development")
    ) {
      this.logger.warn(`Rejecting cross-env batch job ${jobId}`, {
        jobEnv: job.environment,
        nodeEnv: this.config.environment,
      });
      await this.di.broker.nack(`batch:${def.name}`, jobId, 5_000);
      return;
    }

    // Mark as active
    job.status = "active";
    job.attemptMade = (job.attemptMade ?? 0) + 1;
    job.startedAt = new Date();
    await this.di.storage.save("jobs", jobId, job);

    // Build context
    const abortController = new AbortController();
    let progressValue = 0;
    let discarded = false;
    const startTime = Date.now();

    // Timeout handling
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (def.timeout) {
      timeoutHandle = setTimeout(() => {
        abortController.abort();
      }, def.timeout);
    }

    // Build log function
    const logFn = Object.assign(
      (level: "info" | "warn" | "error", message: string) => {
        this.logger[level](`[batch:${def.name}] ${message}`, { jobId });
      },
      {
        info: (msg: string) =>
          this.logger.info(`[batch:${def.name}] ${msg}`, { jobId }),
        warn: (msg: string) =>
          this.logger.warn(`[batch:${def.name}] ${msg}`, { jobId }),
        error: (msg: string) =>
          this.logger.error(`[batch:${def.name}] ${msg}`, { jobId }),
      },
    );

    const maxAttempts = def.retries?.max ? def.retries.max + 1 : 1;

    const ctx: BatchJobContext = {
      id: jobId,
      name: def.name,
      batch: job.data.items,
      batchSize: job.data.items.length,
      groupKey: job.data.groupKey,
      signal: abortController.signal,
      get aborted() {
        return abortController.signal.aborted;
      },
      attempt: job.attemptMade,
      maxAttempts,
      createdAt: new Date(job.createdAt),
      get duration() {
        return Date.now() - startTime;
      },
      environment: this.config.environment ?? "development",
      project: this.config.project ?? "default",
      async progress(percent: number) {
        progressValue = Math.min(100, Math.max(0, percent));
      },
      getProgress: () => progressValue,
      log: logFn,
      discard: () => {
        discarded = true;
      },
    };

    try {
      const result = await def.handler(ctx as any);

      if (timeoutHandle) clearTimeout(timeoutHandle);

      job.status = "completed";
      job.finishedAt = new Date();
      job.returnValue = result;
      await this.di.storage.save("jobs", jobId, job);
      await this.di.broker.ack(`batch:${def.name}`, jobId);

      // onSuccess hook
      if (def.hooks?.onSuccess) {
        try {
          await def.hooks.onSuccess(job as any, result);
        } catch {
          // Hook errors don't fail the job
        }
      }

      // Retention pruning
      await pruneAfterCompletion({
        namespace: "jobs",
        jobId,
        status: "completed",
        moduleRemoveConfig:
          def.removeOnComplete ?? keepHistoryToRemoveConfig(def.keepHistory),
        globalRemoveConfig: this.batchConfig?.removeOnComplete,
        filterKey: "queueName",
        filterValue: `batch:${def.name}`,
      });

      this.logger.info(`Batch job completed: ${jobId}`, {
        items: job.data.items.length,
        durationMs: Date.now() - startTime,
      });
    } catch (err) {
      if (timeoutHandle) clearTimeout(timeoutHandle);

      const error = err instanceof Error ? err : new Error(String(err));

      // onFail hook
      if (def.hooks?.onFail) {
        try {
          await def.hooks.onFail(job as any, error);
        } catch {
          // Hook errors are swallowed
        }
      }

      // Should retry?
      const shouldRetry =
        !discarded && def.retries?.max && job.attemptMade < def.retries.max + 1;

      if (shouldRetry) {
        // Calculate backoff delay
        const baseDelay = def.retries?.baseDelay ?? 1_000;
        const strategy = def.retries?.strategy ?? "exponential";

        let delay = baseDelay;
        if (strategy === "exponential") {
          delay = baseDelay * 2 ** (job.attemptMade - 1);
        }

        job.status = "waiting";
        job.error = error.message;
        await this.di.storage.save("jobs", jobId, job);
        await this.di.broker.nack(`batch:${def.name}`, jobId, delay);

        this.logger.warn(`Batch job failed, retrying in ${delay}ms: ${jobId}`, {
          attempt: job.attemptMade,
          error: error.message,
        });
      } else {
        // Permanent failure
        job.status = "failed";
        job.error = error.message;
        job.finishedAt = new Date();
        await this.di.storage.save("jobs", jobId, job);
        await this.di.broker.ack(`batch:${def.name}`, jobId);

        // DLQ handler
        if (def.deadLetter?.enabled && def.deadLetter?.onDead) {
          try {
            await def.deadLetter.onDead(job as any);
          } catch {
            // DLQ handler errors are swallowed
          }
        }

        // Retention pruning for failed jobs
        await pruneAfterCompletion({
          namespace: "jobs",
          jobId,
          status: "failed",
          moduleRemoveConfig:
            def.removeOnFail ??
            keepHistoryToRemoveConfig(def.keepFailedHistory),
          globalRemoveConfig: this.batchConfig?.removeOnFail,
          filterKey: "queueName",
          filterValue: `batch:${def.name}`,
        });

        this.logger.error(`Batch job permanently failed: ${jobId}`, {
          attempt: job.attemptMade,
          error: error.message,
        });
      }
    }
  }
}
