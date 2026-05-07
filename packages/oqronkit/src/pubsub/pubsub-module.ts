import { randomUUID } from "node:crypto";
import { OqronContainer } from "../engine/container.js";
import type { Logger } from "../engine/logger/index.js";
import type { OqronConfig } from "../engine/types/config.types.js";
import type { IOqronModule } from "../engine/types/module.types.js";
import type { PubSubModuleDef } from "../modules.js";
import { PubSubTopicEngine } from "./pubsub-engine.js";
import { drainPendingSubscriptions, getRegisteredTopics } from "./registry.js";
import type { ITopic, TopicConfig } from "./types.js";

export class PubSubModule implements IOqronModule {
  readonly name = "pubsub";
  enabled = true;

  private readonly nodeId = `pubsub-${randomUUID()}`;
  private readonly engines = new Map<string, PubSubTopicEngine>();
  private reconciliationTimer: ReturnType<typeof setInterval> | null = null;
  private retentionTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribers: Array<() => Promise<void>> = [];

  constructor(
    _config: OqronConfig,
    private readonly logger: Logger,
    private readonly moduleConfig: PubSubModuleDef,
  ) {}

  private get di(): OqronContainer {
    return OqronContainer.get();
  }

  async init(): Promise<void> {
    for (const config of getRegisteredTopics()) {
      this.getOrCreateEngine(config);
      const existing = await this.di.storage.get<any>(
        "pubsub_topics",
        config.name,
      );
      await this.di.storage.save("pubsub_topics", config.name, {
        ...(existing ?? {}),
        name: config.name,
        partitions: Math.max(1, config.distribution?.partitions ?? 1),
        tags: config.tags ?? [],
        updatedAt: new Date(),
        createdAt: existing?.createdAt ?? new Date(),
      });
    }
    this.logger.info(
      `PubSub module initialized with ${this.engines.size} topic(s)`,
    );
  }

  async start(): Promise<void> {
    for (const pending of drainPendingSubscriptions()) {
      const engine = this.engines.get(pending.topicName);
      if (!engine) continue;
      this.unsubscribers.push(await engine.subscribe(pending.config));
    }
    this.startReconciliationLoop();
    this.startRetentionLoop();
    this.logger.info("PubSub module started.");
  }

  async stop(): Promise<void> {
    if (this.reconciliationTimer) clearInterval(this.reconciliationTimer);
    this.reconciliationTimer = null;
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    this.retentionTimer = null;
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      await unsubscribe();
    }
    for (const engine of this.engines.values()) {
      await engine.stop();
    }
  }

  async enable(): Promise<void> {
    this.enabled = true;
    await this.start();
  }

  async disable(): Promise<void> {
    this.enabled = false;
    await this.stop();
  }

  getTopic<T = any>(name: string): ITopic<T> | undefined {
    return this.engines.get(name) as ITopic<T> | undefined;
  }

  registerTopic<T = any>(config: TopicConfig<T>): ITopic<T> {
    return this.getOrCreateEngine(config) as ITopic<T>;
  }

  private getOrCreateEngine<T = any>(
    config: TopicConfig<T>,
  ): PubSubTopicEngine<T> {
    const existing = this.engines.get(config.name);
    if (existing) return existing as PubSubTopicEngine<T>;
    const engine = new PubSubTopicEngine(
      config,
      this.moduleConfig,
      this.logger,
    );
    this.engines.set(config.name, engine);
    return engine;
  }

  private startReconciliationLoop(): void {
    const interval = this.moduleConfig.reconciliationIntervalMs ?? 30_000;
    if (interval <= 0 || this.reconciliationTimer) return;
    this.reconciliationTimer = setInterval(() => {
      void this.runLeaderTask("pubsub:reconciliation", interval, async () => {
        for (const engine of this.engines.values()) {
          await engine.reconcile();
        }
      });
    }, interval);
    this.reconciliationTimer.unref();
  }

  private startRetentionLoop(): void {
    const interval = this.moduleConfig.retentionIntervalMs ?? 60_000;
    if (interval <= 0 || this.retentionTimer) return;
    this.retentionTimer = setInterval(() => {
      void this.runLeaderTask("pubsub:retention", interval, async () => {
        for (const engine of this.engines.values()) {
          await engine.cleanupRetention();
        }
      });
    }, interval);
    this.retentionTimer.unref();
  }

  private async runLeaderTask(
    lockKey: string,
    intervalMs: number,
    task: () => Promise<void>,
  ): Promise<void> {
    const ttlMs = Math.max(intervalMs * 2, 10_000);
    const acquired = await this.di.lock.acquire(lockKey, this.nodeId, ttlMs);
    if (!acquired) return;
    try {
      await task();
    } catch (err) {
      this.logger.warn(`PubSub leader task "${lockKey}" failed: ${err}`);
    } finally {
      await this.di.lock.release(lockKey, this.nodeId).catch(() => {});
    }
  }
}
