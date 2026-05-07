import { randomUUID } from "node:crypto";
import { OqronContainer } from "../engine/container.js";
import { OqronEventBus } from "../engine/events/event-bus.js";
import { LruCache } from "./lru.js";
import { decodeValue, encodeValue } from "./serializer.js";
import type {
  CacheBatchContext,
  CacheBatchResult,
  CacheConfig,
  CacheContext,
  CacheEntryRecord,
  CacheFetchManyOptions,
  CacheFetchOptions,
  CacheInstanceRecord,
  CacheInvalidationMessage,
  CacheSetOptions,
  CacheSnapshot,
  CacheStats,
  CacheTagRecord,
  ICache,
} from "./types.js";

const NS_ENTRIES = "cache_entries";
const NS_TAGS = "cache_tags";
const NS_INSTANCES = "cache_instances";
const NS_STATS = "cache_stats";
const CHANNEL_INVALIDATION = "cache:invalidation";

type L1Entry<T> = {
  value: T;
  key: string;
  tags: string[];
  negative: boolean;
  createdAt: number;
  expiresAt: number;
  staleUntil: number;
  sizeBytes: number;
};

type StatMutation = (stats: CacheStats) => void;

export class CacheEngine<T = any> implements ICache<T> {
  private readonly l1: LruCache<L1Entry<T>>;
  private readonly nodeId = randomUUID();
  private readonly inflight = new Map<string, Promise<T>>();
  private l2Failures = 0;
  private l2CircuitOpenUntil = 0;
  private warnedNoBroadcast = false;

  constructor(public readonly config: CacheConfig<T>) {
    validateConfig(config);
    this.l1 = new LruCache<L1Entry<T>>(config.l1?.maxItems ?? 1000);
  }

  get name(): string {
    return this.config.name;
  }

  get version(): number {
    return this.config.version ?? 1;
  }

  get l1Enabled(): boolean {
    return this.config.l1?.enabled !== false;
  }

  get l2Enabled(): boolean {
    return this.config.l2?.enabled !== false;
  }

  get staleWhileRevalidateMs(): number {
    return this.config.staleWhileRevalidateMs ?? 0;
  }

  get staleIfErrorMs(): number {
    return this.config.staleIfErrorMs ?? 0;
  }

  get compression() {
    return this.config.l2?.compression ?? "none";
  }

  async get(key: string): Promise<T | null> {
    if (!(await this.isInstanceEnabled())) return null;
    const now = Date.now();

    const fromL1 = this.getL1(key, now);
    if (fromL1.hit) {
      await this.recordHit(key, "L1", fromL1.stale);
      return fromL1.entry.value;
    }

    const fromL2 = await this.getL2(key, now);
    if (fromL2.hit) {
      await this.recordHit(key, "L2", fromL2.stale);
      return fromL2.entry.value;
    }

    await this.recordMiss(key);
    return null;
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  async getOrFetch(key: string, opts: CacheFetchOptions<T> = {}): Promise<T> {
    const enabled = await this.isInstanceEnabled();
    if (enabled && !opts.forceRefresh) {
      const cached = await this.readForFetch(key);
      if (cached.hit) {
        if (cached.stale) this.refreshInBackground(key, opts);
        await this.recordHit(key, cached.tier, cached.stale);
        return cached.entry.value;
      }
      await this.recordMiss(key);
    }

    if (opts.ignoreCacheWrite || !enabled) {
      return this.fetchValue(key, opts);
    }

    const localSingleFlight =
      this.config.stampedeProtection?.localSingleFlight !== false;
    const inflightKey = this.entryId(key);
    if (localSingleFlight) {
      const existing = this.inflight.get(inflightKey);
      if (existing) return existing;
    }

    const promise = this.fetchWithClusterProtection(key, opts);
    if (localSingleFlight) {
      this.inflight.set(inflightKey, promise);
      const cleanup = () => this.inflight.delete(inflightKey);
      promise.then(cleanup, cleanup);
    }
    return promise;
  }

  async set(key: string, value: T, opts: CacheSetOptions = {}): Promise<void> {
    if (!(await this.isInstanceEnabled())) return;
    await this.writeEntry(key, value, opts);
    await this.updateStats((stats) => {
      stats.sets++;
      stats.lastAccessAt = Date.now();
    });
    OqronEventBus.emit("cache:set", this.name, key);
  }

  async delete(key: string): Promise<boolean> {
    const existed = await this.deleteKeyEverywhere(key);
    await this.broadcast({
      type: "key",
      cacheName: this.name,
      version: this.version,
      key,
      sourceNode: this.nodeId,
    });
    await this.updateStats((stats) => {
      stats.deletes++;
      if (existed) stats.invalidations++;
      stats.lastAccessAt = Date.now();
    });
    OqronEventBus.emit("cache:delete", this.name, key);
    return existed;
  }

  async getMany(keys: string[]): Promise<Record<string, T | null>> {
    const result: Record<string, T | null> = {};
    for (const key of keys) result[key] = await this.get(key);
    return result;
  }

  async getOrFetchMany(
    keys: string[],
    opts: CacheFetchManyOptions<T> = {},
  ): Promise<Record<string, T>> {
    const result: Record<string, T> = {};
    const missed: string[] = [];
    if (!opts.forceRefresh) {
      for (const key of keys) {
        const cached = await this.readForFetch(key);
        if (cached.hit) {
          result[key] = cached.entry.value;
          await this.recordHit(key, cached.tier, cached.stale);
          if (cached.stale) this.refreshInBackground(key, opts);
        } else {
          missed.push(key);
          await this.recordMiss(key);
        }
      }
    } else {
      missed.push(...keys);
    }

    if (missed.length === 0) return result;

    if (opts.fetcherMany ?? this.config.fetcherMany) {
      const values = await this.fetchManyValues(missed, opts);
      for (const key of missed) {
        if (!(key in values)) continue;
        result[key] = values[key];
        if (!opts.ignoreCacheWrite) {
          await this.writeEntry(key, values[key], {
            ttlMs: opts.ttlMs,
            tags: resolveManyTags(opts.tags, key),
          });
        }
      }
      return result;
    }

    const concurrency = opts.concurrency ?? 10;
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(concurrency, missed.length) },
      async () => {
        while (cursor < missed.length) {
          const key = missed[cursor++];
          try {
            result[key] = await this.getOrFetch(key, {
              ...opts,
              tags: resolveManyTags(opts.tags, key),
              fetcher: opts.fetcher,
            });
          } catch (err) {
            if (opts.stopOnError) throw err;
          }
        }
      },
    );
    await Promise.all(workers);
    return result;
  }

  async setMany(
    entries: Array<{ key: string; value: T; opts?: CacheSetOptions }>,
  ): Promise<CacheBatchResult> {
    return this.batch(
      entries.map((entry) => entry.key),
      async (_key, idx) => {
        const entry = entries[idx];
        await this.set(entry.key, entry.value, entry.opts);
      },
    );
  }

  async deleteMany(keys: string[]): Promise<CacheBatchResult> {
    return this.batch(keys, async (key) => {
      await this.delete(key);
    });
  }

  async invalidate(key: string): Promise<void> {
    await this.delete(key);
  }

  async invalidatePrefix(prefix: string): Promise<number> {
    const entries = await this.listEntries();
    let count = 0;
    for (const entry of entries) {
      if (entry.key.startsWith(prefix)) {
        await this.deleteKeyEverywhere(entry.key);
        count++;
      }
    }
    this.evictLocalPrefix(prefix);
    await this.broadcast({
      type: "prefix",
      cacheName: this.name,
      version: this.version,
      prefix,
      sourceNode: this.nodeId,
    });
    await this.afterInvalidation(null, null, count);
    return count;
  }

  async invalidateTags(tags: string[]): Promise<number> {
    const keys = new Set<string>();
    for (const tag of tags) {
      const record = await this.di.storage.get<CacheTagRecord>(
        NS_TAGS,
        this.tagId(tag),
      );
      for (const key of record?.keys ?? []) keys.add(key);
      await this.di.storage.delete(NS_TAGS, this.tagId(tag));
    }

    for (const key of keys) await this.deleteKeyEverywhere(key);
    this.evictLocalKeys([...keys]);
    await this.broadcast({
      type: "tags",
      cacheName: this.name,
      version: this.version,
      tags,
      keys: [...keys],
      sourceNode: this.nodeId,
    });
    await this.afterInvalidation(null, tags, keys.size);
    return keys.size;
  }

  async invalidateAll(): Promise<number> {
    const entries = await this.listEntries();
    for (const entry of entries) await this.deleteKeyEverywhere(entry.key);
    const tags = await this.listTags();
    for (const tag of tags) await this.di.storage.delete(NS_TAGS, tag.id);
    const count = this.l1.clear() + entries.length;
    await this.broadcast({
      type: "all",
      cacheName: this.name,
      version: this.version,
      sourceNode: this.nodeId,
    });
    await this.afterInvalidation(null, null, count);
    return entries.length;
  }

  async prime(
    key: string,
    value: T,
    opts: CacheSetOptions = {},
  ): Promise<void> {
    await this.writeEntry(key, value, opts);
  }

  async refresh(key: string, opts: CacheFetchOptions<T> = {}): Promise<T> {
    return this.getOrFetch(key, { ...opts, forceRefresh: true });
  }

  async stats(): Promise<CacheStats> {
    const stats =
      (await this.di.storage.get<CacheStats>(NS_STATS, this.name)) ??
      this.defaultStats();
    stats.l1Size = this.l1.size;
    stats.l1ApproxBytes = this.l1.approxBytes;
    stats.circuitOpen = this.isCircuitOpen();
    return stats;
  }

  async snapshot(): Promise<CacheSnapshot> {
    const [instance, stats, entries] = await Promise.all([
      this.di.storage.get<CacheInstanceRecord>(NS_INSTANCES, this.name),
      this.stats(),
      this.listEntries(),
    ]);
    return {
      name: this.name,
      instance,
      stats,
      l1: {
        size: this.l1.size,
        keys: this.l1.keys(),
        approxBytes: this.l1.approxBytes,
      },
      entries: entries.map((entry) => ({
        key: entry.key,
        tags: entry.tags,
        expiresAt: entry.expiresAt,
        staleUntil: entry.staleUntil,
        negative: entry.negative,
      })),
      exportedAt: new Date(),
    };
  }

  async persistInstanceRecord(existing?: CacheInstanceRecord | null) {
    const now = new Date();
    const record: CacheInstanceRecord = {
      name: this.name,
      version: this.version,
      enabled: existing?.enabled ?? true,
      tags: this.config.tags ?? [],
      l1Enabled: this.l1Enabled,
      l2Enabled: this.l2Enabled,
      ttlMs:
        typeof this.config.ttlMs === "number" ? this.config.ttlMs : "dynamic",
      staleWhileRevalidateMs: this.staleWhileRevalidateMs,
      staleIfErrorMs: this.staleIfErrorMs,
      compression: this.compression,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.di.storage.save(NS_INSTANCES, this.name, record);
    const stats = await this.di.storage.get<CacheStats>(NS_STATS, this.name);
    if (!stats)
      await this.di.storage.save(NS_STATS, this.name, this.defaultStats());
  }

  async handleInvalidationMessage(
    message: CacheInvalidationMessage,
  ): Promise<void> {
    if (message.sourceNode === this.nodeId) return;
    if (message.cacheName !== this.name || message.version !== this.version) {
      return;
    }
    if (message.type === "key") this.l1.delete(message.key);
    if (message.type === "prefix") this.evictLocalPrefix(message.prefix);
    if (message.type === "tags") this.evictLocalKeys(message.keys);
    if (message.type === "all") this.l1.clear();
  }

  async cleanupExpired(): Promise<number> {
    const now = Date.now();
    let evicted = 0;
    for (const [key, entry] of this.l1.entries()) {
      if (entry.staleUntil <= now) {
        this.l1.delete(key);
        evicted++;
      }
    }
    for (const entry of await this.listEntries()) {
      if (entry.staleUntil <= now) {
        await this.deleteKeyEverywhere(entry.key);
        evicted++;
      }
    }
    if (evicted > 0) {
      await this.updateStats((stats) => {
        stats.evictions += evicted;
      });
    }
    return evicted;
  }

  async runPrewarm(): Promise<void> {
    if (!this.config.prewarm) return;
    const keys = await this.config.prewarm.keys();
    await this.getOrFetchMany(keys, {
      forceRefresh: true,
      concurrency: this.config.prewarm.concurrency,
    });
  }

  private get di(): OqronContainer {
    return OqronContainer.get();
  }

  private entryId(key: string): string {
    return `${this.name}:${this.version}:${key}`;
  }

  private tagId(tag: string): string {
    return `${this.name}:${this.version}:${tag}`;
  }

  private getL1(
    key: string,
    now: number,
  ): { hit: true; stale: boolean; entry: L1Entry<T> } | { hit: false } {
    if (!this.l1Enabled) return { hit: false };
    const entry = this.l1.get(key);
    if (!entry) return { hit: false };
    if (entry.expiresAt > now) return { hit: true, stale: false, entry };
    if (entry.staleUntil > now) return { hit: true, stale: true, entry };
    this.l1.delete(key);
    return { hit: false };
  }

  private async getL2(
    key: string,
    now: number,
  ): Promise<
    { hit: true; stale: boolean; entry: L1Entry<T> } | { hit: false }
  > {
    if (!this.l2Enabled || this.isCircuitOpen()) return { hit: false };
    try {
      const record = await this.di.storage.get<CacheEntryRecord>(
        NS_ENTRIES,
        this.entryId(key),
      );
      if (!record) return { hit: false };
      if (record.staleUntil <= now) {
        await this.deleteKeyEverywhere(key);
        return { hit: false };
      }
      const value = await decodeValue<T>(
        record.payload,
        this.config,
        record.compression,
        record.encrypted,
      );
      const entry: L1Entry<T> = {
        value,
        key,
        tags: record.tags,
        negative: record.negative,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        staleUntil: record.staleUntil,
        sizeBytes: record.sizeBytes,
      };
      if (this.l1Enabled) this.l1.set(key, entry, record.sizeBytes);
      return { hit: true, stale: record.expiresAt <= now, entry };
    } catch (err) {
      await this.noteL2Failure(err);
      return { hit: false };
    }
  }

  private async readForFetch(
    key: string,
  ): Promise<
    | { hit: true; tier: "L1" | "L2"; stale: boolean; entry: L1Entry<T> }
    | { hit: false }
  > {
    const now = Date.now();
    const l1 = this.getL1(key, now);
    if (l1.hit) return { ...l1, tier: "L1" };
    const l2 = await this.getL2(key, now);
    if (l2.hit) return { ...l2, tier: "L2" };
    return { hit: false };
  }

  private async writeEntry(
    key: string,
    value: T,
    opts: CacheSetOptions = {},
  ): Promise<void> {
    const now = Date.now();
    const tags = [
      ...new Set([...(this.config.tags ?? []), ...(opts.tags ?? [])]),
    ];
    const ttlMs = this.resolveTtl(value, key, opts.ttlMs, tags);
    const expiresAt = now + this.applyJitter(ttlMs);
    const staleUntil =
      expiresAt + Math.max(this.staleWhileRevalidateMs, this.staleIfErrorMs);
    const negative = value === null;

    const encoded = await encodeValue(value, this.config, this.compression);
    const l1Entry: L1Entry<T> = {
      value,
      key,
      tags,
      negative,
      createdAt: now,
      expiresAt,
      staleUntil,
      sizeBytes: encoded.sizeBytes,
    };

    if (this.l1Enabled && !opts.ignoreL1) {
      const evicted = this.l1.set(key, l1Entry, encoded.sizeBytes);
      if (evicted.length > 0) {
        await this.updateStats((stats) => {
          stats.evictions += evicted.length;
        });
      }
    }

    if (this.l2Enabled && !opts.ignoreL2 && !this.isCircuitOpen()) {
      try {
        const record: CacheEntryRecord = {
          id: this.entryId(key),
          cacheName: this.name,
          version: this.version,
          key,
          payload: encoded.payload,
          compression: this.compression,
          encrypted: encoded.encrypted,
          tags,
          negative,
          createdAt: now,
          expiresAt,
          staleUntil,
          sizeBytes: encoded.sizeBytes,
        };
        await this.di.storage.save(NS_ENTRIES, record.id, record);
        await this.updateTagIndex(key, tags);
        this.l2Failures = 0;
      } catch (err) {
        await this.noteL2Failure(err);
      }
    }
  }

  private resolveTtl(
    value: T,
    key: string,
    override: number | undefined,
    tags: string[],
  ): number {
    if (override !== undefined) return override;
    if (value === null && this.config.negativeCache?.enabled) {
      return this.config.negativeCache.ttlMs ?? 30_000;
    }
    if (typeof this.config.ttlMs === "number") return this.config.ttlMs;
    const ctx = this.createContext(key, tags);
    const ttl = this.config.ttlMs(value, ctx);
    return ctxTtl(ctx) ?? ttl;
  }

  private applyJitter(ttlMs: number): number {
    const jitter = this.config.ttlJitter ?? 0.1;
    if (jitter <= 0) return ttlMs;
    const spread = ttlMs * jitter;
    const delta = Math.random() * spread * 2 - spread;
    return Math.max(1, Math.round(ttlMs + delta));
  }

  private async fetchWithClusterProtection(
    key: string,
    opts: CacheFetchOptions<T>,
  ): Promise<T> {
    const clusterLock = this.config.stampedeProtection?.clusterLock === true;
    if (!clusterLock) return this.fetchAndStore(key, opts);

    const lockTtlMs = this.config.stampedeProtection?.lockTtlMs ?? 30_000;
    const lockKey = `cache:fetch:${this.entryId(key)}`;
    const acquired = await this.di.lock.acquire(
      lockKey,
      this.nodeId,
      lockTtlMs,
    );
    if (acquired) {
      try {
        return await this.fetchAndStore(key, opts);
      } finally {
        await this.di.lock.release(lockKey, this.nodeId);
      }
    }

    const startedAt = Date.now();
    const pollMs = this.config.stampedeProtection?.pollIntervalMs ?? 100;
    const timeoutMs = opts.timeoutMs ?? lockTtlMs;
    while (Date.now() - startedAt < timeoutMs) {
      await sleep(pollMs);
      const cached = await this.readForFetch(key);
      if (cached.hit) return cached.entry.value;
    }

    if (this.config.stampedeProtection?.allowFollowerFetchOnTimeout) {
      return this.fetchAndStore(key, opts);
    }
    const stale = await this.readForFetch(key);
    if (stale.hit) return stale.entry.value;
    throw new Error(
      `[OqronKit:Cache] Timed out waiting for cluster fetch lock for "${this.name}:${key}".`,
    );
  }

  private async fetchAndStore(
    key: string,
    opts: CacheFetchOptions<T>,
  ): Promise<T> {
    try {
      const value = await this.fetchValue(key, opts);
      if (opts.ignoreCacheWrite) return value;
      if (!this.shouldCacheValue(value)) {
        return value;
      }
      await this.writeEntry(key, value, {
        ttlMs: opts.ttlMs,
        tags: opts.tags,
      });
      return value;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      await this.updateStats((stats) => {
        stats.fetchErrors++;
        stats.lastErrorAt = Date.now();
      });
      await this.config.hooks?.onFetchError?.(key, error);
      OqronEventBus.emit("cache:refresh:error", this.name, key, error);
      const stale = await this.readForFetch(key);
      if (stale.hit && stale.stale) {
        OqronEventBus.emit("cache:stale-served", this.name, key);
        return stale.entry.value;
      }
      throw error;
    }
  }

  private async fetchValue(
    key: string,
    opts: CacheFetchOptions<T>,
  ): Promise<T> {
    const fetcher = opts.fetcher ?? this.config.fetcher;
    if (!fetcher) {
      throw new Error(
        `[OqronKit:Cache] "${this.name}" requires a fetcher for getOrFetch("${key}"). Provide config.fetcher or opts.fetcher.`,
      );
    }
    const startedAt = Date.now();
    const dynamicTags = [...(opts.tags ?? [])];
    const ctx = this.createContext(key, dynamicTags);
    await this.updateStats((stats) => {
      stats.fetches++;
    });
    OqronEventBus.emit("cache:refresh:start", this.name, key);
    const promise = fetcher(key, ctx);
    const value =
      opts.timeoutMs && opts.timeoutMs > 0
        ? await withTimeout(promise, opts.timeoutMs)
        : await promise;
    opts.tags = dynamicTags;
    const ttlOverride = ctxTtl(ctx);
    if (ttlOverride !== undefined) opts.ttlMs = ttlOverride;
    const latency = Date.now() - startedAt;
    await this.updateStats((stats) => {
      const previous =
        stats.fetches <= 1 ? latency : stats.averageFetchLatencyMs;
      stats.averageFetchLatencyMs =
        stats.fetches <= 1 ? latency : Math.round((previous + latency) / 2);
    });
    OqronEventBus.emit("cache:refresh:success", this.name, key, latency);
    return value;
  }

  private shouldCacheValue(value: T): boolean {
    if (value !== null) return true;
    if (this.config.negativeCache?.shouldCache) {
      return this.config.negativeCache.shouldCache(value);
    }
    return this.config.negativeCache?.enabled === true;
  }

  private async fetchManyValues(
    keys: string[],
    opts: CacheFetchManyOptions<T>,
  ): Promise<Record<string, T>> {
    const fetcherMany = opts.fetcherMany ?? this.config.fetcherMany;
    if (!fetcherMany) return {};
    const ctx: CacheBatchContext = {
      keys,
      environment: this.di.config?.environment ?? "development",
      project: this.di.config?.project ?? "default",
      log: this.logFor(),
    };
    const promise = fetcherMany(keys, ctx);
    return opts.timeoutMs ? withTimeout(promise, opts.timeoutMs) : promise;
  }

  private createContext(key: string, dynamicTags: string[]): CacheContext {
    let ttlOverride: number | undefined;
    return {
      key,
      environment: this.di.config?.environment ?? "development",
      project: this.di.config?.project ?? "default",
      attempt: 1,
      tags(tags: string[]) {
        dynamicTags.push(...tags);
      },
      ttl(ms: number) {
        ttlOverride = ms;
      },
      log: this.logFor(),
      get _ttlOverride() {
        return ttlOverride;
      },
    } as CacheContext;
  }

  private logFor(): CacheContext["log"] {
    return {
      info: () => {},
      warn: () => {},
      error: () => {},
    };
  }

  private async updateTagIndex(key: string, tags: string[]): Promise<void> {
    for (const tag of tags) {
      const id = this.tagId(tag);
      const existing = await this.di.storage.get<CacheTagRecord>(NS_TAGS, id);
      const keys = new Set(existing?.keys ?? []);
      keys.add(key);
      const now = Date.now();
      await this.di.storage.save(NS_TAGS, id, {
        id,
        cacheName: this.name,
        version: this.version,
        tag,
        keys: [...keys],
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      } satisfies CacheTagRecord);
    }
  }

  private async deleteKeyEverywhere(key: string): Promise<boolean> {
    const l1Deleted = this.l1.delete(key);
    const existing = await this.di.storage.get<CacheEntryRecord>(
      NS_ENTRIES,
      this.entryId(key),
    );
    if (existing) {
      await this.di.storage.delete(NS_ENTRIES, this.entryId(key));
      for (const tag of existing.tags) await this.removeKeyFromTag(tag, key);
    }
    return l1Deleted || !!existing;
  }

  private async removeKeyFromTag(tag: string, key: string): Promise<void> {
    const id = this.tagId(tag);
    const record = await this.di.storage.get<CacheTagRecord>(NS_TAGS, id);
    if (!record) return;
    record.keys = record.keys.filter((candidate) => candidate !== key);
    record.updatedAt = Date.now();
    if (record.keys.length === 0) {
      await this.di.storage.delete(NS_TAGS, id);
    } else {
      await this.di.storage.save(NS_TAGS, id, record);
    }
  }

  private async broadcast(message: CacheInvalidationMessage): Promise<void> {
    if (!this.di.broker.broadcast) {
      if (!this.warnedNoBroadcast) {
        this.warnedNoBroadcast = true;
      }
      return;
    }
    await this.di.broker.broadcast(CHANNEL_INVALIDATION, message);
  }

  private evictLocalPrefix(prefix: string): void {
    for (const key of this.l1.keys()) {
      if (key.startsWith(prefix)) this.l1.delete(key);
    }
  }

  private evictLocalKeys(keys: string[]): void {
    for (const key of keys) this.l1.delete(key);
  }

  private async afterInvalidation(
    key: string | null,
    tags: string[] | null,
    count: number,
  ): Promise<void> {
    await this.updateStats((stats) => {
      stats.invalidations += count;
      stats.lastAccessAt = Date.now();
    });
    await this.config.hooks?.onInvalidation?.(key, tags);
    OqronEventBus.emit("cache:invalidate", this.name, { key, tags, count });
  }

  private async recordHit(
    key: string,
    tier: "L1" | "L2",
    stale: boolean,
  ): Promise<void> {
    await this.updateStats((stats) => {
      stats.hits++;
      if (tier === "L1") stats.l1Hits++;
      if (tier === "L2") stats.l2Hits++;
      if (stale) stats.staleHits++;
      stats.lastAccessAt = Date.now();
    });
    await this.config.hooks?.onCacheHit?.(key, tier, stale);
    OqronEventBus.emit("cache:hit", this.name, key, tier, stale);
  }

  private async recordMiss(key: string): Promise<void> {
    await this.updateStats((stats) => {
      stats.misses++;
      stats.lastAccessAt = Date.now();
    });
    await this.config.hooks?.onCacheMiss?.(key);
    OqronEventBus.emit("cache:miss", this.name, key);
  }

  private async updateStats(mutate: StatMutation): Promise<void> {
    const current =
      (await this.di.storage.get<CacheStats>(NS_STATS, this.name)) ??
      this.defaultStats();
    mutate(current);
    current.l1Size = this.l1.size;
    current.l1ApproxBytes = this.l1.approxBytes;
    current.circuitOpen = this.isCircuitOpen();
    current.updatedAt = Date.now();
    await this.di.storage.save(NS_STATS, this.name, current);
  }

  private defaultStats(): CacheStats {
    return {
      name: this.name,
      hits: 0,
      misses: 0,
      staleHits: 0,
      l1Hits: 0,
      l2Hits: 0,
      sets: 0,
      deletes: 0,
      fetches: 0,
      fetchErrors: 0,
      invalidations: 0,
      evictions: 0,
      averageFetchLatencyMs: 0,
      l1Size: 0,
      l1ApproxBytes: 0,
      circuitOpen: false,
      lastAccessAt: 0,
      lastErrorAt: null,
      updatedAt: Date.now(),
    };
  }

  private async noteL2Failure(err: unknown): Promise<void> {
    this.l2Failures++;
    const threshold = this.config.l2?.circuitBreaker?.failuresThreshold ?? 3;
    if (this.l2Failures >= threshold) {
      this.l2CircuitOpenUntil =
        Date.now() + (this.config.l2?.circuitBreaker?.resetTimeoutMs ?? 60_000);
      OqronEventBus.emit("cache:circuit-open", this.name, err);
    }
    await this.updateStats((stats) => {
      stats.lastErrorAt = Date.now();
    });
  }

  private isCircuitOpen(): boolean {
    if (this.l2CircuitOpenUntil <= Date.now()) {
      if (this.l2CircuitOpenUntil !== 0) {
        OqronEventBus.emit("cache:circuit-close", this.name);
      }
      this.l2CircuitOpenUntil = 0;
      return false;
    }
    return true;
  }

  private async listEntries(): Promise<CacheEntryRecord[]> {
    return this.di.storage.list<CacheEntryRecord>(NS_ENTRIES, {
      cacheName: this.name,
      version: this.version,
    });
  }

  private async listTags(): Promise<CacheTagRecord[]> {
    return this.di.storage.list<CacheTagRecord>(NS_TAGS, {
      cacheName: this.name,
      version: this.version,
    });
  }

  private async isInstanceEnabled(): Promise<boolean> {
    const rec = await this.di.storage.get<CacheInstanceRecord>(
      NS_INSTANCES,
      this.name,
    );
    return rec?.enabled ?? true;
  }

  private refreshInBackground(
    key: string,
    opts: CacheFetchOptions<T> | CacheFetchManyOptions<T>,
  ): void {
    void this.getOrFetch(key, {
      ...(opts as CacheFetchOptions<T>),
      forceRefresh: true,
    }).catch(() => {});
  }

  private async batch(
    keys: string[],
    fn: (key: string, idx: number) => Promise<void>,
  ): Promise<CacheBatchResult> {
    const result: CacheBatchResult = {
      ok: true,
      total: keys.length,
      succeeded: [],
      failed: [],
      errors: {},
    };
    for (let idx = 0; idx < keys.length; idx++) {
      const key = keys[idx];
      try {
        await fn(key, idx);
        result.succeeded.push(key);
      } catch (err) {
        result.ok = false;
        result.failed.push(key);
        result.errors[key] = err instanceof Error ? err.message : String(err);
      }
    }
    return result;
  }
}

function validateConfig(config: CacheConfig<any>): void {
  if (!config.name) throw new Error("[OqronKit:Cache] `name` is required.");
  if (typeof config.ttlMs === "number" && config.ttlMs <= 0) {
    throw new Error("[OqronKit:Cache] `ttlMs` must be positive.");
  }
  if (typeof config.ttlJitter === "number") {
    if (config.ttlJitter < 0 || config.ttlJitter > 1) {
      throw new Error("[OqronKit:Cache] `ttlJitter` must be between 0 and 1.");
    }
  }
  if (config.l1?.maxItems !== undefined && config.l1.maxItems < 1) {
    throw new Error("[OqronKit:Cache] `l1.maxItems` must be positive.");
  }
}

function resolveManyTags(
  tags: string[] | ((key: string) => string[]) | undefined,
  key: string,
): string[] | undefined {
  if (!tags) return undefined;
  return typeof tags === "function" ? tags(key) : tags;
}

function ctxTtl(ctx: CacheContext): number | undefined {
  return (ctx as any)._ttlOverride;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Operation timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
