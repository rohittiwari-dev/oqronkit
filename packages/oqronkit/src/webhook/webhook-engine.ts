import { randomUUID } from "node:crypto";
import type { IOqronModule, Logger } from "../engine/index.js";
import { OqronContainer, OqronEventBus } from "../engine/index.js";
import { HeartbeatWorker } from "../engine/lock/heartbeat-worker.js";
import { StallDetector } from "../engine/lock/stall-detector.js";
import type { OqronConfig } from "../engine/types/config.types.js";
import type { OqronJob } from "../engine/types/job.types.js";
import {
  type BackoffOptions,
  calculateBackoff,
} from "../engine/utils/backoffs.js";
import { pruneAfterCompletion } from "../engine/utils/job-retention.js";
import type { WebhookModuleDef } from "../modules.js";
import { deliverWebhook, shouldRetryDelivery } from "./delivery.js";
import { signWebhookPayload } from "./hmac.js";
import { getRegisteredWebhooks } from "./registry.js";
import type { WebhookConfig, WebhookDeliveryPayload } from "./types.js";

export class WebhookEngine implements IOqronModule {
  public readonly name = "webhook";
  public enabled = true;
  private running = false;
  private workerIdStr = randomUUID();
  private activeJobs = new Map<string, Promise<void>>();
  private activeJobsByDispatcher = new Map<string, Set<string>>();
  private heartbeats = new Map<string, HeartbeatWorker>();
  private stallDetector: StallDetector | null = null;
  private consumersByQueue = new Map<string, () => Promise<void>>();

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
    this.logger.info(
      `Initialized WebhookEngine covering ${dispatchers.length} dispatchers`,
    );
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const dispatchers = getRegisteredWebhooks();
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
        const dispatcherName = dispatchers.find((_d) =>
          this.activeJobs.has(jobId),
        )?.name;
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
              void this.di.broker.nack(dispatcherName, jobId);
            });
        }
      },
    );
  }

  private startPolling(dispatcher: WebhookConfig) {
    const queueName = dispatcher.name;
    const heartbeatMs = this.webhookConfig?.heartbeatMs ?? 5000;

    // Create an active set for this dispatcher
    if (!this.activeJobsByDispatcher.has(queueName)) {
      this.activeJobsByDispatcher.set(queueName, new Set());
    }

    const t = setInterval(() => {
      this.poll(dispatcher).catch((e) =>
        this.logger.error(`Webhook poller crashed for ${queueName}`, e),
      );
    }, heartbeatMs);
    t.unref();
    this.timers.push(t);

    // Register the stop function
    this.consumersByQueue.set(queueName, async () => {
      clearInterval(t);
    });

    // Initial poll
    setTimeout(() => this.poll(dispatcher), 0);
  }

  private async poll(dispatcher: WebhookConfig): Promise<void> {
    if (!this.running || !this.enabled) return;

    const queueName = dispatcher.name;
    const concurrency =
      dispatcher.concurrency ?? this.webhookConfig?.concurrency ?? 5;
    const lockTtlMs = this.webhookConfig?.lockTtlMs ?? 30000;

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
      "fifo",
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
  }

  private async processJob(
    dispatcher: WebhookConfig,
    jobId: string,
  ): Promise<void> {
    const lockKey = `webhook:job:${jobId}`;
    const ttlMs = 30000;
    const hbMs = 5000;

    const acquired = await this.di.lock.acquire(
      lockKey,
      this.workerIdStr,
      ttlMs,
    );
    if (!acquired) {
      await this.di.broker.nack(dispatcher.name, jobId, 1000);
      return;
    }

    const heartbeat = new HeartbeatWorker(
      this.di.lock,
      this.logger,
      lockKey,
      this.workerIdStr,
      ttlMs,
      hbMs,
    );
    heartbeat.start();
    this.heartbeats.set(jobId, heartbeat);

    const job = await this.di.storage.get<OqronJob<WebhookDeliveryPayload>>(
      "jobs",
      jobId,
    );

    if (!job) {
      await heartbeat.stop();
      this.heartbeats.delete(jobId);
      await this.di.lock.release(lockKey, this.workerIdStr);
      await this.di.broker.ack(dispatcher.name, jobId);
      return;
    }

    if (job.status === "paused" || job.status === "completed") {
      await heartbeat.stop();
      this.heartbeats.delete(jobId);
      await this.di.lock.release(lockKey, this.workerIdStr);
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
      await heartbeat.stop();
      this.heartbeats.delete(jobId);
      await this.di.lock.release(lockKey, this.workerIdStr);
      await this.di.broker.nack(dispatcher.name, jobId);
      return;
    }

    job.attemptMade = (job.attemptMade ?? 0) + 1;
    job.status = "active";
    const startTs = Date.now();
    job.startedAt = new Date();
    await this.di.storage.save("jobs", jobId, job);

    OqronEventBus.emit("job:start", dispatcher.name, jobId, this.name);

    try {
      const payload = job.data;
      const bodyStr = JSON.stringify(payload.transformedBody ?? payload.body);

      // Sign payload if security is configured
      if (payload.security) {
        const ts = payload.timestamp || startTs;
        const signature = await signWebhookPayload(
          bodyStr,
          payload.security.signingSecret,
          ts,
          payload.security.signingAlgorithm,
          payload.security.signFunction,
        );

        const sigHeader = payload.security.signingHeader ?? "X-Oqron-Signature";
        payload.headers[sigHeader] = signature;

        if (payload.security.includeTimestamp !== false) {
          const tsHeader =
            payload.security.timestampHeader ?? "X-Oqron-Timestamp";
          payload.headers[tsHeader] = ts.toString();
        }
      }

      // Deliver HTTP Payload
      const result = await deliverWebhook(
        payload.url,
        payload.method,
        payload.headers,
        bodyStr,
        dispatcher.timeout ?? 30000,
      );

      // Check for success (2xx) vs retryable/error
      if (result.status >= 200 && result.status < 300) {
        // Success
        await this.handleSuccess(dispatcher, job, result, lockKey);
      } else {
        const retryStatusCodes = dispatcher.retries?.retryOnStatus;
        if (shouldRetryDelivery(result.status, retryStatusCodes)) {
          throw new Error(
            `HTTP ${result.status} Response. Body: ${result.body?.substring(0, 50)}...`,
          );
        } else {
          // Hard fail - no retries
          await this.handleHardFail(
            dispatcher,
            job,
            new Error(`Unretryable HTTP ${result.status} status`),
            lockKey,
          );
        }
      }
    } catch (e: any) {
      await this.handleRetry(dispatcher, job, e, lockKey);
    }
  }

  private async handleSuccess(
    dispatcher: WebhookConfig,
    job: OqronJob<WebhookDeliveryPayload>,
    result: any,
    lockKey: string,
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

    const hb = this.heartbeats.get(job.id);
    if (hb) {
      await hb.stop();
      this.heartbeats.delete(job.id);
    }
    await this.di.lock.release(lockKey, this.workerIdStr);
    await this.di.broker.ack(dispatcher.name, job.id);

    OqronEventBus.emit("job:success", dispatcher.name, job.id);
  }

  private async handleRetry(
    dispatcher: WebhookConfig,
    job: OqronJob<WebhookDeliveryPayload>,
    error: Error,
    lockKey: string,
  ) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    job.logs ??= [];
    job.logs.push({
      ts: new Date(),
      level: "error",
      msg: `Execution attempt ${job.attemptMade} failed: ${errorMsg}`,
    });

    const maxRetries = dispatcher.retries?.max ?? 0;
    const effectiveMaxRetries = job.opts?.attempts
      ? job.opts.attempts - 1
      : maxRetries;

    if (job.attemptMade > effectiveMaxRetries) {
      await this.handleHardFail(dispatcher, job, error, lockKey);
    } else {
      // Retry
      const backoffOpts: BackoffOptions | undefined = dispatcher.retries
        ? {
            type: dispatcher.retries.strategy ?? "fixed",
            delay: dispatcher.retries.baseDelay ?? 5000,
          }
        : undefined;
      const backoffMs = calculateBackoff(
        backoffOpts,
        job.attemptMade,
        dispatcher.retries?.maxDelay,
      );
      job.status = "delayed";
      job.runAt = new Date(Date.now() + backoffMs);
      job.timeline ??= [];
      job.timeline.push({
        ts: new Date(),
        from: "active",
        to: "delayed",
        reason: `Retry ${job.attemptMade} failed, backing off...`,
      });

      await this.di.storage.save("jobs", job.id, job);

      const hb = this.heartbeats.get(job.id);
      if (hb) {
        await hb.stop();
        this.heartbeats.delete(job.id);
      }
      await this.di.lock.release(lockKey, this.workerIdStr);

      await this.di.broker.nack(dispatcher.name, job.id, backoffMs);
    }
  }

  private async handleHardFail(
    dispatcher: WebhookConfig,
    job: OqronJob<WebhookDeliveryPayload>,
    error: Error,
    lockKey: string,
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

    const hb = this.heartbeats.get(job.id);
    if (hb) {
      await hb.stop();
      this.heartbeats.delete(job.id);
    }
    await this.di.lock.release(lockKey, this.workerIdStr);
    await this.di.broker.ack(dispatcher.name, job.id);

    OqronEventBus.emit("job:fail", dispatcher.name, job.id, error);
  }

  async stop(): Promise<void> {
    this.running = false;

    this.stallDetector?.stop();
    this.stallDetector = null;

    for (const consumerStop of this.consumersByQueue.values()) {
      await consumerStop();
    }
    this.consumersByQueue.clear();

    for (const t of this.timers) {
      clearInterval(t);
    }
    this.timers = [];

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

    this.logger.info("WebhookEngine stopped.");
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
