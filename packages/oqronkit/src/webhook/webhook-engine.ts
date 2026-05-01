import { randomUUID } from "node:crypto";
import type { IOqronModule, Logger } from "../engine/index.js";
import { OqronContainer, OqronEventBus } from "../engine/index.js";
import { LagMonitor } from "../engine/lag-monitor.js";
import { CrossNodeStallScanner } from "../engine/lock/cross-node-stall-scanner.js";
import { HeartbeatWorker } from "../engine/lock/heartbeat-worker.js";
import { StallDetector } from "../engine/lock/stall-detector.js";
import type { OqronConfig } from "../engine/types/config.types.js";
import type { BrokerStrategy } from "../engine/types/engine.js";
import type { OqronJob } from "../engine/types/job.types.js";
import {
  type BackoffOptions,
  calculateBackoff,
} from "../engine/utils/backoffs.js";
import { pruneAfterCompletion } from "../engine/utils/job-retention.js";
import { ReconciliationEngine } from "../engine/utils/reconciliation-engine.js";
import type { WebhookModuleDef } from "../modules.js";
import { rateLimit } from "../ratelimit/define-ratelimit.js";
import type { IRateLimiter } from "../ratelimit/types.js";
import {
  createCircuitBreaker,
  type ICircuitBreaker,
} from "./circuit-breaker.js";
import { deliverWebhook, shouldRetryDelivery } from "./delivery.js";
import { signWebhookPayload } from "./hmac.js";
import { deregisterWebhook, getRegisteredWebhooks } from "./registry.js";
import type {
  WebhookConfig,
  WebhookDeliveryPayload,
  WebhookEndpoint,
  WebhookRetryConfig,
  WebhookSecurity,
} from "./types.js";

export class WebhookEngine implements IOqronModule {
  public readonly name = "webhook";
  public enabled = true;
  private running = false;
  private readonly workerIdStr = randomUUID();
  private activeJobs = new Map<string, Promise<void>>();
  private activeJobsByDispatcher = new Map<string, Set<string>>();
  private heartbeats = new Map<string, HeartbeatWorker>();
  private abortControllers = new Map<string, AbortController>();
  private stallDetector: StallDetector | null = null;
  private consumersByQueue = new Map<string, () => Promise<void>>();
  private isPolling = new Set<string>();
  private pausedDispatchers = new Set<string>();
  private dispatcherTimers = new Map<string, NodeJS.Timeout>();
  private crossNodeScanner: CrossNodeStallScanner | null = null;
  private lagMonitor: LagMonitor | null = null;
  private reconciler: ReconciliationEngine | null = null;
  private circuitBreaker: ICircuitBreaker | null = null;
  private outboundLimiters = new Map<string, IRateLimiter>();

  private timers: NodeJS.Timeout[] = [];

  constructor(
    public config: OqronConfig,
    private logger: Logger,
    private webhookConfig?: WebhookModuleDef,
    private container?: OqronContainer,
  ) {}

  private get di(): OqronContainer {
    return this.container ?? OqronContainer.get();
  }

  async init(): Promise<void> {
    const dispatchers = getRegisteredWebhooks();

    // Version-based config migration (parity with queue-engine/worker-engine)
    for (const d of dispatchers) {
      const codeVersion = d.version ?? 0;
      const existing = await this.di.storage.get<any>(
        "webhook_instances",
        d.name,
      );
      const dbVersion = existing?.version ?? 0;

      // Downgrade protection — don't overwrite newer DB state with older code
      if (existing && codeVersion < dbVersion) {
        this.logger.warn("Code version is older than DB — skipping overwrite", {
          name: d.name,
          codeVersion,
          dbVersion,
        });
      } else if (existing && codeVersion > dbVersion) {
        this.logger.info("Webhook config version upgraded", {
          name: d.name,
          from: dbVersion,
          to: codeVersion,
        });
        await this.di.storage.save("webhook_instances", d.name, {
          ...(existing || {}),
          version: codeVersion,
          enabled: existing.enabled ?? true,
        });
        OqronEventBus.emit(
          "webhook:version-upgraded",
          d.name,
          dbVersion,
          codeVersion,
        );
      } else if (!existing) {
        // First registration — seed the instance record
        await this.di.storage.save("webhook_instances", d.name, {
          version: codeVersion,
          enabled: true,
        });
      }

      // Load persisted pause state into memory
      const instanceState = await this.di.storage.get<any>(
        "webhook_instances",
        d.name,
      );
      if (instanceState && instanceState.enabled === false) {
        this.pausedDispatchers.add(d.name);
      }
    }

    this.logger.info(
      `Initialized WebhookEngine covering ${dispatchers.length} dispatchers`,
    );
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const dispatchers = getRegisteredWebhooks();

    // G7: Initialize circuit breaker (memory default, shared if storage available)
    const cbConfig = {
      failureThreshold: 5,
      resetTimeoutMs: 30_000,
      halfOpenMaxAttempts: 1,
    };
    // Use shared storage if in distributed mode, else memory
    const isDistributed = this.config.mode && this.config.mode !== "default";
    this.circuitBreaker = createCircuitBreaker(
      cbConfig,
      isDistributed ? this.di.storage : undefined,
      isDistributed ? this.di.lock : undefined,
    );

    for (const dispatcher of dispatchers) {
      if (!this.consumersByQueue.has(dispatcher.name)) {
        this.startPolling(dispatcher);
      }
    }

    const stalledInterval = this.webhookConfig?.stalledInterval ?? 30000;
    this.stallDetector = new StallDetector(
      this.di.lock,
      this.logger,
      stalledInterval,
    );
    this.stallDetector.start(
      () =>
        Array.from(this.heartbeats.entries()).map(([jobId, _]) => ({
          key: `webhook:job:${jobId}`,
          ownerId: this.workerIdStr,
        })),
      (key: string) => {
        const jobId = key.replace("webhook:job:", "");
        this.logger.warn(
          `Stall detected for Webhook job ${jobId} — nacking back to broker`,
        );
        this.heartbeats.get(jobId)?.stop();
        this.heartbeats.delete(jobId);
        const dispatcherName = this.getDispatcherForActiveJob(jobId);
        if (dispatcherName) {
          this.di.storage
            .get<any>("jobs", jobId)
            .then(async (job) => {
              if (job) {
                job.stalledCount = (job.stalledCount ?? 0) + 1;
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
              }
            })
            .finally(() => {
              OqronEventBus.emit("job:stalled", dispatcherName, jobId);
              void this.di.broker.nack(dispatcherName, jobId);
            });
        }
      },
    );

    // Start cross-node stall scanner (B2) — recovers orphaned jobs from crashed nodes
    const scannerConfig = this.webhookConfig?.crossNodeStallScanner;
    if (scannerConfig) {
      const scannerOpts =
        typeof scannerConfig === "object" ? scannerConfig : {};
      this.crossNodeScanner = new CrossNodeStallScanner(
        this.di.storage,
        this.di.lock,
        this.logger,
        {
          intervalMs: scannerOpts.intervalMs ?? 60_000,
          lockPrefix: "webhook",
          maxStalledCount: scannerOpts.maxStalledCount ?? 3,
        },
      );
      this.crossNodeScanner.start(async (job) => {
        OqronEventBus.emit("job:stalled", job.queueName, job.id);
        if (job.status !== "failed") {
          await this.nackJob(job.queueName, job);
        }
      });
    }

    // Start event-loop lag monitor (B3)
    const lagConfig = this.webhookConfig?.lagMonitor;
    if (lagConfig) {
      this.lagMonitor = new LagMonitor(
        this.logger,
        lagConfig.maxLagMs ?? 500,
        lagConfig.sampleIntervalMs ?? 50,
      );
      this.lagMonitor.start();
    }

    // Start storage-broker reconciliation engine (B4)
    const reconConfig = this.webhookConfig?.reconciliation;
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

  private getDispatcherForActiveJob(jobId: string): string | undefined {
    for (const [dispatcherName, jobs] of this.activeJobsByDispatcher.entries()) {
      if (jobs.has(jobId)) return dispatcherName;
    }
    return undefined;
  }

  private async finishJobExecution(jobId: string): Promise<void> {
    const hb = this.heartbeats.get(jobId);
    if (hb) {
      await hb.stop();
      this.heartbeats.delete(jobId);
    }
    this.abortControllers.delete(jobId);
  }

  private async nackJob(
    queueName: string,
    job: Pick<OqronJob<WebhookDeliveryPayload>, "id" | "opts">,
    delayMs?: number,
  ): Promise<void> {
    if (job.opts?.priority !== undefined) {
      await this.di.broker.nack(queueName, job.id, delayMs, job.opts.priority);
      return;
    }
    if (delayMs !== undefined) {
      await this.di.broker.nack(queueName, job.id, delayMs);
      return;
    }
    await this.di.broker.nack(queueName, job.id);
  }

  private startPolling(dispatcher: WebhookConfig) {
    const queueName = dispatcher.name;
    const basePollMs = this.webhookConfig?.heartbeatMs ?? 5000;
    // G3: Add random jitter to prevent thundering herd on multi-node startup
    const jitter = Math.round(Math.random() * 500);
    const pollIntervalMs = basePollMs + jitter;

    // Create an active set for this dispatcher
    if (!this.activeJobsByDispatcher.has(queueName)) {
      this.activeJobsByDispatcher.set(queueName, new Set());
    }

    const t = setInterval(() => {
      this.poll(dispatcher).catch((e) =>
        this.logger.error(`Webhook poller crashed for ${queueName}`, e),
      );
    }, pollIntervalMs);
    t.unref();
    this.timers.push(t);
    this.dispatcherTimers.set(queueName, t);

    // Register the stop function
    this.consumersByQueue.set(queueName, async () => {
      clearInterval(t);
      this.dispatcherTimers.delete(queueName);
    });

    // Initial poll
    setTimeout(() => this.poll(dispatcher), 0);
  }

  private async poll(dispatcher: WebhookConfig): Promise<void> {
    if (!this.running || !this.enabled) return;
    // B7: Skip polling for paused dispatchers
    if (this.pausedDispatchers.has(dispatcher.name)) return;
    // B6: Reentrant guard — prevent concurrent poll for same dispatcher
    if (this.isPolling.has(dispatcher.name)) return;
    // B3: Circuit breaker — skip polling if event loop is stalled
    if (this.lagMonitor?.isCircuitTripped) return;

    this.isPolling.add(dispatcher.name);
    try {
      const queueName = dispatcher.name;
      const concurrency =
        dispatcher.concurrency ?? this.webhookConfig?.concurrency ?? 5;
      const lockTtlMs = this.webhookConfig?.lockTtlMs ?? 30000;
      const strategy: BrokerStrategy = this.webhookConfig?.strategy ?? "fifo";

      const activeSet = this.activeJobsByDispatcher.get(queueName);
      const activeCount = activeSet?.size ?? 0;
      const freeSlots = concurrency - activeCount;

      if (freeSlots <= 0) return;

      // Claim jobs from the broker
      const jobIds = await this.di.broker.claim(
        queueName,
        this.workerIdStr,
        freeSlots,
        lockTtlMs,
        strategy,
      );

      for (const jobId of jobIds) {
        if (!this.running || !this.enabled) {
          await this.di.broker.nack(queueName, jobId);
          continue;
        }

        const promise = this.processJob(dispatcher, jobId);
        this.activeJobs.set(jobId, promise);
        activeSet?.add(jobId);

        promise
          .catch((e) => this.logger.error("Job process loop failed", e))
          .finally(() => {
            this.activeJobs.delete(jobId);
            activeSet?.delete(jobId);
          });
      }
    } finally {
      this.isPolling.delete(dispatcher.name);
    }
  }

  private async processJob(
    dispatcher: WebhookConfig,
    jobId: string,
  ): Promise<void> {
    const lockKey = `webhook:job:${jobId}`;
    const ttlMs = this.webhookConfig?.lockTtlMs ?? 30000;
    const hbMs = this.webhookConfig?.heartbeatMs ?? 5000;
    const trackProgress = this.webhookConfig?.trackProgress !== false;

    const heartbeat = new HeartbeatWorker(
      this.di.lock,
      this.logger,
      lockKey,
      this.workerIdStr,
      ttlMs,
      hbMs,
    );
    const acquired = await heartbeat.start();
    if (!acquired) {
      await this.di.broker.nack(dispatcher.name, jobId, 1000);
      return;
    }
    this.heartbeats.set(jobId, heartbeat);

    const abortController = new AbortController();
    this.abortControllers.set(jobId, abortController);

    const job = await this.di.storage.get<OqronJob<WebhookDeliveryPayload>>(
      "jobs",
      jobId,
    );

    if (!job) {
      await this.finishJobExecution(jobId);
      await this.di.broker.ack(dispatcher.name, jobId);
      return;
    }

    if (job.status === "paused" || job.status === "completed") {
      await this.finishJobExecution(jobId);
      await this.di.broker.ack(dispatcher.name, jobId);
      return;
    }

    // Isolate by environment
    if (
      job.environment &&
      this.config.environment &&
      job.environment !== this.config.environment
    ) {
      this.logger.warn(`Returning webhook ${jobId} — wrong environment`, {
        jobEnv: job.environment,
        workerEnv: this.config.environment,
      });
      await this.finishJobExecution(jobId);
      await this.di.broker.nack(dispatcher.name, jobId);
      return;
    }

    // B15: Isolate by project (L3 safety net — L1 container prefix is primary)
    if (
      job.project &&
      this.config.project &&
      job.project !== this.config.project
    ) {
      this.logger.warn(`Returning webhook ${jobId} — wrong project`, {
        jobProject: job.project,
        workerProject: this.config.project,
      });
      await this.finishJobExecution(jobId);
      await this.di.broker.nack(dispatcher.name, jobId);
      return;
    }

    // B16: Progress tracking helper (opt-in, default true)
    const updateProgress = async (percent: number) => {
      if (!trackProgress) return;
      job.progressPercent = percent;
      await this.di.storage.save("jobs", jobId, job);
    };

    await updateProgress(10); // Job claimed

    job.attemptMade = (job.attemptMade ?? 0) + 1;
    job.status = "active";
    const startTs = Date.now();
    job.startedAt = new Date();
    await this.di.storage.save("jobs", jobId, job);

    OqronEventBus.emit("job:start", dispatcher.name, jobId, this.name);

    try {
      const payload = job.data;
      const bodyStr = JSON.stringify(payload.transformedBody ?? payload.body);
      const endpoint = await this.resolveEndpointConfig(
        dispatcher,
        payload.endpointName,
      );
      if (!endpoint || endpoint.enabled === false) {
        await this.handleHardFail(
          dispatcher,
          job,
          new Error(
            `Webhook endpoint "${payload.endpointName}" is disabled or no longer registered`,
          ),
        );
        return;
      }
      const retryConfig = this.resolveRetryConfig(dispatcher, endpoint);

      // Sign payload if security is configured
      const security = await this.resolveSecurity(
        endpoint.security ?? dispatcher.security ?? payload.security,
      );
      if (security) {
        const ts = payload.timestamp || startTs;
        const signature = await signWebhookPayload(
          bodyStr,
          security.signingSecret,
          ts,
          security.signingAlgorithm,
          security.signFunction,
        );

        const sigHeader = security.signingHeader ?? "X-Oqron-Signature";
        payload.headers[sigHeader] = signature;

        if (security.includeTimestamp !== false) {
          const tsHeader =
            security.timestampHeader ?? "X-Oqron-Timestamp";
          payload.headers[tsHeader] = ts.toString();
        }
      }

      // G11: Send idempotency key header
      if (payload.idempotencyKey) {
        payload.headers["Idempotency-Key"] = payload.idempotencyKey;
      }

      await updateProgress(30); // Payload signed

      const endpointKey = `${dispatcher.name}:${payload.endpointName}`;

      // G8: Outbound rate limiting per endpoint
      const limiter = this.resolveOutboundLimiter(
        dispatcher,
        payload.endpointName,
        endpoint,
      );
      if (limiter) {
        const rlResult = await limiter.check({ key: endpointKey });
        if (!rlResult.allowed) {
          const delayMs = rlResult.resetMs || 5000;
          this.logger.warn(
            `Outbound rate limit hit for ${endpointKey}, re-queuing in ${delayMs}ms`,
          );
          job.logs ??= [];
          job.logs.push({
            ts: new Date(),
            level: "warn",
            msg: `Rate limited — re-queuing with ${delayMs}ms delay`,
          });
          await this.delayJob(dispatcher, job, delayMs, "Outbound rate limit");
          return;
        }
      }

      // G7: Check circuit breaker before sending
      if (
        this.circuitBreaker &&
        (await this.circuitBreaker.isOpen(endpointKey))
      ) {
        this.logger.warn(
          `Circuit OPEN for ${endpointKey} — skipping delivery, re-queuing`,
        );
        await this.delayJob(dispatcher, job, 15000, "Circuit breaker open");
        return;
      }

      if (abortController.signal.aborted) {
        throw new Error("Cancelled");
      }

      await updateProgress(50); // HTTP request sent

      // Deliver HTTP Payload
      const result = await deliverWebhook(
        payload.url,
        payload.method,
        payload.headers,
        bodyStr,
        dispatcher.timeout ?? 30000,
      );

      if (abortController.signal.aborted) {
        throw new Error("Cancelled");
      }

      await updateProgress(70); // Response received

      // G9: Store full delivery attempt trace in job logs
      job.logs ??= [];
      job.logs.push({
        ts: new Date(),
        level: result.status >= 200 && result.status < 300 ? "info" : "warn",
        msg: `Attempt #${job.attemptMade}: HTTP ${result.status} ${payload.method} ${payload.url} (${result.durationMs}ms)${result.retryAfterMs ? ` retryAfter=${result.retryAfterMs}ms` : ""}`,
      });

      // Check for success (2xx) vs retryable/error
      if (result.status >= 200 && result.status < 300) {
        await this.circuitBreaker?.recordSuccess(endpointKey);
        await updateProgress(90); // Validated
        // Success
        await this.handleSuccess(dispatcher, job, result);
      } else {
        await this.circuitBreaker?.recordFailure(endpointKey);
        const retryStatusCodes = retryConfig?.retryOnStatus;
        if (shouldRetryDelivery(result.status, retryStatusCodes)) {
          throw Object.assign(
            new Error(
              `HTTP ${result.status} Response. Body: ${result.body?.substring(0, 50)}...`,
            ),
            { retryAfterMs: result.retryAfterMs },
          );
        } else {
          // Hard fail - no retries
          await this.handleHardFail(
            dispatcher,
            job,
            new Error(`Unretryable HTTP ${result.status} status`),
          );
        }
      }
    } catch (e: any) {
      // Record circuit breaker failure on exceptions (network errors, timeouts)
      const endpointKey = `${dispatcher.name}:${job.data?.endpointName}`;
      await this.circuitBreaker?.recordFailure(endpointKey);
      if (abortController.signal.aborted) {
        await this.handleHardFail(dispatcher, job, new Error("Cancelled"));
      } else {
        const endpoint = await this.resolveEndpointConfig(
          dispatcher,
          job.data?.endpointName,
        );
        await this.handleRetry(
          dispatcher,
          job,
          e,
          this.resolveRetryConfig(dispatcher, endpoint),
        );
      }
    }
  }

  private async delayJob(
    dispatcher: WebhookConfig,
    job: OqronJob<WebhookDeliveryPayload>,
    delayMs: number,
    reason: string,
  ): Promise<void> {
    job.status = "delayed";
    job.runAt = new Date(Date.now() + delayMs);
    job.timeline ??= [];
    job.timeline.push({
      ts: new Date(),
      from: "active",
      to: "delayed",
      reason: `${reason}; re-queuing with ${delayMs}ms delay`,
    });
    await this.di.storage.save("jobs", job.id, job);
    await this.finishJobExecution(job.id);
    await this.nackJob(dispatcher.name, job, delayMs);
  }

  private async handleSuccess(
    dispatcher: WebhookConfig,
    job: OqronJob<WebhookDeliveryPayload>,
    result: any,
  ) {
    job.status = "completed";
    job.finishedAt = new Date();
    job.progressPercent = 100;
    job.returnValue = result;
    job.timeline ??= [];
    job.timeline.push({
      ts: new Date(),
      from: "active",
      to: "completed",
    });

    if (dispatcher.hooks?.onSuccess) {
      void Promise.resolve()
        .then(() => dispatcher.hooks!.onSuccess!(job, result))
        .catch((e) =>
          this.logger.error("onSuccess hook failed", { err: String(e) }),
        );
    }

    await this.di.storage.save("jobs", job.id, job);
    await pruneAfterCompletion({
      namespace: "jobs",
      jobId: job.id,
      status: "completed",
      jobRemoveConfig: job.opts?.removeOnComplete,
      moduleRemoveConfig: dispatcher.removeOnComplete,
      globalRemoveConfig: this.webhookConfig?.removeOnComplete,
      filterKey: "queueName",
      filterValue: dispatcher.name,
    });

    await this.finishJobExecution(job.id);
    await this.di.broker.ack(dispatcher.name, job.id);

    OqronEventBus.emit("job:success", dispatcher.name, job.id);
  }

  private async handleRetry(
    dispatcher: WebhookConfig,
    job: OqronJob<WebhookDeliveryPayload>,
    error: Error,
    retryConfig?: WebhookRetryConfig,
  ) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    job.logs ??= [];
    job.logs.push({
      ts: new Date(),
      level: "error",
      msg: `Execution attempt ${job.attemptMade} failed: ${errorMsg}`,
    });

    const maxRetries = retryConfig?.max ?? 0;
    const effectiveMaxRetries = job.opts?.attempts
      ? job.opts.attempts - 1
      : maxRetries;

    if (job.attemptMade > effectiveMaxRetries) {
      await this.handleHardFail(dispatcher, job, error);
    } else {
      // Retry
      const backoffOpts: BackoffOptions | undefined = retryConfig
        ? {
            type: retryConfig.strategy ?? "fixed",
            delay: retryConfig.baseDelay ?? 5000,
          }
        : undefined;
      const computedBackoff = calculateBackoff(
        backoffOpts,
        job.attemptMade,
        retryConfig?.maxDelay,
      );

      // G6: Respect Retry-After header if present (capped at maxDelay)
      const retryAfterMs = (error as any)?.retryAfterMs as number | undefined;
      const maxDelay = retryConfig?.maxDelay ?? 300_000;
      const backoffMs = retryAfterMs
        ? Math.min(retryAfterMs, maxDelay)
        : computedBackoff;

      job.status = "delayed";
      job.runAt = new Date(Date.now() + backoffMs);
      job.timeline ??= [];
      job.timeline.push({
        ts: new Date(),
        from: "active",
        to: "delayed",
        reason: retryAfterMs
          ? `Retry ${job.attemptMade} failed, server requested ${retryAfterMs}ms delay`
          : `Retry ${job.attemptMade} failed, backing off ${backoffMs}ms...`,
      });

      await this.di.storage.save("jobs", job.id, job);

      await this.finishJobExecution(job.id);

      await this.nackJob(dispatcher.name, job, backoffMs);
    }
  }

  private async handleHardFail(
    dispatcher: WebhookConfig,
    job: OqronJob<WebhookDeliveryPayload>,
    error: Error,
  ) {
    job.status = "failed";
    job.error = error.message;
    job.finishedAt = new Date();
    job.timeline ??= [];
    job.timeline.push({
      ts: new Date(),
      from: "active",
      to: "failed",
    });

    if (dispatcher.hooks?.onFail) {
      void Promise.resolve()
        .then(() => dispatcher.hooks!.onFail!(job, error))
        .catch((e) =>
          this.logger.error("onFail hook failed", { err: String(e) }),
        );
    }

    if (dispatcher.deadLetter?.enabled) {
      try {
        await dispatcher.deadLetter.onDead?.(job);
      } catch (e: any) {
        const em = e instanceof Error ? e.message : String(e);
        this.logger.error(`onDead hook failed: ${em}`);
      }
    }

    await this.di.storage.save("jobs", job.id, job);
    await pruneAfterCompletion({
      namespace: "jobs",
      jobId: job.id,
      status: "failed",
      jobRemoveConfig: job.opts?.removeOnFail,
      moduleRemoveConfig: dispatcher.removeOnFail,
      globalRemoveConfig: this.webhookConfig?.removeOnFail,
      filterKey: "queueName",
      filterValue: dispatcher.name,
    });

    await this.finishJobExecution(job.id);
    await this.di.broker.ack(dispatcher.name, job.id);

    OqronEventBus.emit("job:fail", dispatcher.name, job.id, error);
  }

  async stop(): Promise<void> {
    this.running = false;

    // B5: Full infrastructure cleanup (parity with Queue/Worker)
    this.stallDetector?.stop();
    this.stallDetector = null;

    this.crossNodeScanner?.stop();
    this.crossNodeScanner = null;

    this.lagMonitor?.stop();
    this.lagMonitor = null;

    this.reconciler?.stop();
    this.reconciler = null;

    // G8: Cleanup outbound rate limiters
    this.outboundLimiters.clear();

    for (const consumerStop of this.consumersByQueue.values()) {
      await consumerStop();
    }
    this.consumersByQueue.clear();
    this.dispatcherTimers.clear();

    for (const t of this.timers) {
      clearInterval(t);
    }
    this.timers = [];

    // Cancel all active job AbortControllers
    for (const [, ac] of this.abortControllers) {
      ac.abort();
    }
    this.abortControllers.clear();

    for (const hb of this.heartbeats.values()) {
      await hb.stop();
    }
    this.heartbeats.clear();

    const allActive = Array.from(this.activeJobs.values());
    if (allActive.length > 0) {
      const timeout = this.webhookConfig?.shutdownTimeout ?? 25000;
      await Promise.race([
        Promise.allSettled(allActive),
        new Promise((r) => {
          const h = setTimeout(r, timeout);
          h.unref();
        }),
      ]);
    }

    this.isPolling.clear();
    this.pausedDispatchers.clear();
    this.logger.info("WebhookEngine stopped.");
  }

  // ── Dynamic CRUD (G1, G2, G4) ─────────────────────────────────────────────

  /** G1: Trigger an immediate poll cycle for a specific dispatcher */
  async triggerManual(name: string): Promise<boolean> {
    const dispatchers = getRegisteredWebhooks();
    const d = dispatchers.find((x) => x.name === name);
    if (!d) return false;
    await this.poll(d);
    return true;
  }

  /** G2: Cancel an active job using its AbortController */
  async cancelActiveJob(jobId: string): Promise<boolean> {
    const ac = this.abortControllers.get(jobId);
    if (!ac) return false;
    ac.abort();

    const job = await this.di.storage.get<OqronJob>("jobs", jobId);
    const dispatcherName = job?.queueName ?? this.getDispatcherForActiveJob(jobId);
    if (job) {
      job.status = "failed";
      job.error = "Cancelled by operator";
      job.finishedAt = new Date();
      job.timeline ??= [];
      job.timeline.push({
        ts: new Date(),
        from: "active",
        to: "failed",
        reason: "Manual cancellation",
      });
      await this.di.storage.save("jobs", jobId, job);
    }

    await this.finishJobExecution(jobId);
    this.activeJobs.delete(jobId);
    for (const jobs of this.activeJobsByDispatcher.values()) {
      jobs.delete(jobId);
    }
    if (dispatcherName) {
      await this.di.broker.ack(dispatcherName, jobId);
    }
    OqronEventBus.emit(
      "job:fail",
      dispatcherName ?? "unknown",
      jobId,
      new Error("Cancelled"),
    );
    return true;
  }

  /** G4 / B7: Pause a specific dispatcher — stops claiming new jobs */
  async pauseDispatcher(name: string): Promise<void> {
    this.pausedDispatchers.add(name);
    await this.di.storage.save("webhook_instances", name, { enabled: false });
    await this.di.broker.pause(name);
    OqronEventBus.emit("webhook:paused", name);
    this.logger.info(`Webhook dispatcher "${name}" paused`);
  }

  /** G4 / B7: Resume a paused dispatcher */
  async resumeDispatcher(name: string): Promise<void> {
    this.pausedDispatchers.delete(name);
    await this.di.storage.save("webhook_instances", name, { enabled: true });
    await this.di.broker.resume(name);
    OqronEventBus.emit("webhook:resumed", name);
    this.logger.info(`Webhook dispatcher "${name}" resumed`);
  }

  /** G4: Register a new dispatcher at runtime and start polling */
  async registerDispatcher(config: WebhookConfig): Promise<void> {
    const { registerWebhook } = await import("./registry.js");
    registerWebhook(config);
    await this.di.storage.save("webhook_instances", config.name, {
      version: config.version ?? 0,
      enabled: true,
    });
    if (this.running) {
      this.startPolling(config);
    }
    OqronEventBus.emit("webhook:registered", config.name);
    this.logger.info(
      `Webhook dispatcher "${config.name}" registered at runtime`,
    );
  }

  /** G4: Deregister a dispatcher and stop its polling */
  async deregisterDispatcher(name: string): Promise<boolean> {
    const stopFn = this.consumersByQueue.get(name);
    if (stopFn) {
      await stopFn();
      this.consumersByQueue.delete(name);
    }
    deregisterWebhook(name);
    await this.di.storage.delete("webhook_instances", name);
    this.activeJobsByDispatcher.delete(name);
    OqronEventBus.emit("webhook:deregistered", name);
    this.logger.info(`Webhook dispatcher "${name}" deregistered`);
    return true;
  }

  // ── G10: Resend API ─────────────────────────────────────────────────────────

  /** Clone a failed/DLQ webhook job and re-enqueue for delivery. */
  async resendJob(jobId: string): Promise<string | null> {
    const original = await this.di.storage.get<OqronJob>("jobs", jobId);
    if (!original) return null;
    if (original.status !== "failed") return null;

    const newId = randomUUID();
    const clone: OqronJob = {
      ...original,
      id: newId,
      status: "waiting",
      attemptMade: 0,
      error: undefined,
      stacktrace: undefined,
      returnValue: undefined,
      retriedFromId: jobId,
      triggeredBy: "retry",
      startedAt: undefined,
      finishedAt: undefined,
      durationMs: undefined,
      latencyMs: undefined,
      memoryUsageMb: undefined,
      processedOn: undefined,
      queuedAt: new Date(),
      progressPercent: 0,
      progressLabel: undefined,
      workerId: undefined,
      stalledCount: undefined,
      createdAt: new Date(),
      timeline: [
        {
          ts: new Date(),
          from: original.status,
          to: "waiting" as const,
          reason: "Manual resend",
        },
      ],
      logs: [],
      steps: undefined,
    };

    await this.di.storage.save("jobs", newId, clone);
    // Annotate the original with lineage
    await this.di.storage.save("jobs", jobId, {
      ...original,
      retryReason: `Resent as ${newId}`,
    });
    await this.di.broker.publish(original.queueName, newId);
    OqronEventBus.emit("job:retried", jobId, newId);
    this.logger.info(`Webhook job ${jobId} resent as ${newId}`);
    return newId;
  }

  // ── G8: Outbound Rate Limiter Helper ────────────────────────────────────────

  /** Resolve the outbound rate limiter for an endpoint (lazy-create or user-provided) */
  private async resolveEndpointConfig(
    dispatcher: WebhookConfig,
    endpointName: string,
  ): Promise<WebhookEndpoint | null> {
    const endpoints = Array.isArray(dispatcher.endpoints)
      ? dispatcher.endpoints
      : await dispatcher.endpoints();
    const codeEndpoint =
      endpoints.find((endpoint) => endpoint.name === endpointName) ?? null;
    const dbEndpoint = await this.di.storage.get<any>(
      "webhook_endpoints",
      `${dispatcher.name}:${endpointName}`,
    );

    if (!dbEndpoint) return codeEndpoint;
    if (codeEndpoint) {
      return {
        ...codeEndpoint,
        ...dbEndpoint,
        enabled: dbEndpoint.enabled ?? codeEndpoint.enabled,
      };
    }
    if (dbEndpoint.url && dbEndpoint.events) {
      return dbEndpoint as WebhookEndpoint;
    }
    return null;
  }

  private async resolveSecurity(
    input?: WebhookConfig["security"] | WebhookEndpoint["security"] | WebhookSecurity,
  ): Promise<WebhookSecurity | undefined> {
    if (!input) return undefined;
    if (typeof input === "function") return await input();
    return input;
  }

  private resolveRetryConfig(
    dispatcher: WebhookConfig,
    endpoint: WebhookEndpoint | null,
  ): WebhookRetryConfig | undefined {
    if (!dispatcher.retries && !endpoint?.retries) return undefined;
    return { ...(dispatcher.retries ?? {}), ...(endpoint?.retries ?? {}) };
  }

  private resolveOutboundLimiter(
    dispatcher: WebhookConfig,
    endpointName: string,
    endpointOverride: WebhookEndpoint | null,
  ): IRateLimiter | null {
    const ep = endpointOverride ?? (
      Array.isArray(dispatcher.endpoints)
        ? dispatcher.endpoints.find((e: WebhookEndpoint) => e.name === endpointName)
        : undefined
    );
    if (!ep) return null;

    // Option B: User-provided limiter takes precedence
    if (ep.rateLimiter) return ep.rateLimiter;

    // Option A: Auto-create from simple config
    if (!ep.rateLimit) return null;

    const key = `${dispatcher.name}:${ep.name}`;
    const existing = this.outboundLimiters.get(key);
    if (existing) return existing;

    const created = rateLimit.create({
      name: `webhook:outbound:${key}`,
      algorithm: "sliding-window",
      tiers: [
        {
          name: "outbound",
          key: () => key,
          max: ep.rateLimit.max,
          window: ep.rateLimit.window,
        },
      ],
      failOpen: true,
    });
    this.outboundLimiters.set(key, created);
    return created;
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
}
