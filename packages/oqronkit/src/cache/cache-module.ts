import { randomUUID } from "node:crypto";
import { OqronContainer } from "../engine/container.js";
import type { Logger } from "../engine/logger/index.js";
import type { OqronConfig } from "../engine/types/config.types.js";
import type { IOqronModule } from "../engine/types/module.types.js";
import type { CacheModuleDef } from "../modules.js";
import { getRegisteredCaches } from "./registry.js";
import type { CacheInvalidationMessage } from "./types.js";

const CHANNEL_INVALIDATION = "cache:invalidation";

export class CacheModule implements IOqronModule {
  readonly name = "cache";
  enabled = true;

  private readonly nodeId = randomUUID();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private prewarmTimers: ReturnType<typeof setInterval>[] = [];
  private unsubscribe: (() => void | Promise<void>) | null = null;
  private warnedNoBroadcast = false;

  constructor(
    _config: OqronConfig,
    private readonly logger: Logger,
    private readonly moduleConfig: CacheModuleDef,
  ) {}

  private get di(): OqronContainer {
    return OqronContainer.get();
  }

  async init(): Promise<void> {
    const caches = getRegisteredCaches();
    for (const cache of caches) {
      const existing = await this.di.storage.get<any>(
        "cache_instances",
        cache.name,
      );
      await cache.persistInstanceRecord(existing);
    }
    this.logger.info(`Cache module initialized with ${caches.length} cache(s)`);
  }

  async start(): Promise<void> {
    if (!this.enabled) return;
    await this.startBroadcastSubscription();
    this.startCleanupLoop();
    this.startPrewarmLoops();
    this.logger.info("Cache module started.");
  }

  async stop(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    for (const timer of this.prewarmTimers) clearInterval(timer);
    this.prewarmTimers = [];
    if (this.unsubscribe) {
      await this.unsubscribe();
      this.unsubscribe = null;
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

  private async startBroadcastSubscription(): Promise<void> {
    if (this.unsubscribe) return;
    if (!this.di.broker.subscribe) {
      if (!this.warnedNoBroadcast) {
        this.warnedNoBroadcast = true;
        this.logger.warn(
          "Cache distributed L1 invalidation is disabled because the broker does not support subscribe().",
        );
      }
      return;
    }
    this.unsubscribe = await this.di.broker.subscribe(
      CHANNEL_INVALIDATION,
      async (message) => {
        const payload = message as CacheInvalidationMessage;
        for (const cache of getRegisteredCaches()) {
          await cache.handleInvalidationMessage(payload);
        }
      },
    );
  }

  private startCleanupLoop(): void {
    if (this.cleanupTimer) return;
    const interval = this.moduleConfig.gcIntervalMs ?? 60_000;
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpired().catch((err) => {
        this.logger.warn(`Cache cleanup failed: ${err}`);
      });
    }, interval);
    this.cleanupTimer.unref();
  }

  private startPrewarmLoops(): void {
    for (const cache of getRegisteredCaches()) {
      const prewarm = cache.config.prewarm;
      if (!prewarm) continue;
      const run = () => {
        const jitter = prewarm.jitterMs
          ? Math.floor(Math.random() * prewarm.jitterMs)
          : 0;
        const timer = setTimeout(() => void this.runPrewarm(cache), jitter);
        timer.unref();
      };
      run();
      const interval = setInterval(run, prewarm.intervalMs);
      interval.unref();
      this.prewarmTimers.push(interval);
    }
  }

  private async cleanupExpired(): Promise<void> {
    for (const cache of getRegisteredCaches()) {
      await cache.cleanupExpired();
    }
  }

  private async runPrewarm(cache: {
    name: string;
    runPrewarm(): Promise<void>;
  }): Promise<void> {
    const lockTtl = this.moduleConfig.prewarmLockTtlMs ?? 60_000;
    const lockKey = `cache:prewarm:${cache.name}`;
    const acquired = await this.di.lock.acquire(lockKey, this.nodeId, lockTtl);
    if (!acquired) return;
    try {
      await cache.runPrewarm();
    } catch (err) {
      this.logger.warn(`Cache prewarm failed for "${cache.name}": ${err}`);
    } finally {
      await this.di.lock.release(lockKey, this.nodeId);
    }
  }
}
