export type CacheCompression = "none" | "gzip" | "brotli" | "snappy";

export interface CacheContext {
  readonly key: string;
  readonly environment: string;
  readonly project: string;
  readonly attempt: number;
  tags(tags: string[]): void;
  ttl(ms: number): void;
  log: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
}

export interface CacheBatchContext {
  readonly keys: string[];
  readonly environment: string;
  readonly project: string;
  log: CacheContext["log"];
}

export interface CacheFetchOptions<T = any> {
  forceRefresh?: boolean;
  ignoreCacheWrite?: boolean;
  timeoutMs?: number;
  ttlMs?: number;
  tags?: string[];
  fetcher?: (key: string, ctx: CacheContext) => Promise<T>;
}

export interface CacheFetchManyOptions<T = any> {
  forceRefresh?: boolean;
  ignoreCacheWrite?: boolean;
  timeoutMs?: number;
  ttlMs?: number;
  tags?: string[] | ((key: string) => string[]);
  fetcherMany?: (
    keys: string[],
    ctx: CacheBatchContext,
  ) => Promise<Record<string, T>>;
  fetcher?: (key: string, ctx: CacheContext) => Promise<T>;
  stopOnError?: boolean;
  concurrency?: number;
}

export interface CacheSetOptions {
  ttlMs?: number;
  tags?: string[];
  ignoreL2?: boolean;
  ignoreL1?: boolean;
}

export interface CacheBatchResult {
  ok: boolean;
  total: number;
  succeeded: string[];
  failed: string[];
  errors: Record<string, string>;
}

export interface CacheStats {
  name: string;
  hits: number;
  misses: number;
  staleHits: number;
  l1Hits: number;
  l2Hits: number;
  sets: number;
  deletes: number;
  fetches: number;
  fetchErrors: number;
  invalidations: number;
  evictions: number;
  averageFetchLatencyMs: number;
  l1Size: number;
  l1ApproxBytes: number;
  circuitOpen: boolean;
  lastAccessAt: number;
  lastErrorAt: number | null;
  updatedAt: number;
}

export interface CacheSnapshot {
  name: string;
  instance: CacheInstanceRecord | null;
  stats: CacheStats | null;
  l1: {
    size: number;
    keys: string[];
    approxBytes: number;
  };
  entries: Array<{
    key: string;
    tags: string[];
    expiresAt: number;
    staleUntil: number;
    negative: boolean;
  }>;
  exportedAt: Date;
}

export interface CacheInstanceRecord {
  name: string;
  version: number;
  enabled: boolean;
  tags: string[];
  l1Enabled: boolean;
  l2Enabled: boolean;
  ttlMs: number | "dynamic";
  staleWhileRevalidateMs: number;
  staleIfErrorMs: number;
  compression: CacheCompression;
  createdAt: Date;
  updatedAt: Date;
}

export interface CacheEntryRecord {
  id: string;
  cacheName: string;
  version: number;
  key: string;
  payload: string;
  compression: CacheCompression;
  encrypted: boolean;
  tags: string[];
  negative: boolean;
  createdAt: number;
  expiresAt: number;
  staleUntil: number;
  sizeBytes: number;
}

export interface CacheTagRecord {
  id: string;
  cacheName: string;
  version: number;
  tag: string;
  keys: string[];
  updatedAt: number;
  createdAt: number;
}

export interface CacheConfig<T = any> {
  name: string;
  ttlMs: number | ((value: T, ctx: CacheContext) => number);
  fetcher?: (key: string, ctx: CacheContext) => Promise<T>;
  fetcherMany?: (
    keys: string[],
    ctx: CacheBatchContext,
  ) => Promise<Record<string, T>>;
  version?: number;
  tags?: string[];
  staleWhileRevalidateMs?: number;
  staleIfErrorMs?: number;
  ttlJitter?: number;
  maxValueBytes?: number;
  redactKeysInLogs?: boolean;
  negativeCache?: {
    enabled?: boolean;
    ttlMs?: number;
    shouldCache?: (value: T | null, error?: Error) => boolean;
  };
  l1?: {
    enabled?: boolean;
    maxItems?: number;
  };
  l2?: {
    enabled?: boolean;
    compression?: CacheCompression;
    circuitBreaker?: {
      failuresThreshold?: number;
      resetTimeoutMs?: number;
    };
  };
  serialize?: (value: T) => string | Buffer;
  deserialize?: (payload: string | Buffer) => T;
  encryption?: {
    encrypt: (payload: Buffer) => Promise<Buffer> | Buffer;
    decrypt: (payload: Buffer) => Promise<Buffer> | Buffer;
  };
  stampedeProtection?: {
    localSingleFlight?: boolean;
    clusterLock?: boolean;
    lockTtlMs?: number;
    pollIntervalMs?: number;
    allowFollowerFetchOnTimeout?: boolean;
  };
  prewarm?: {
    intervalMs: number;
    keys: () => Promise<string[]> | string[];
    concurrency?: number;
    jitterMs?: number;
  };
  hooks?: {
    onCacheHit?: (
      key: string,
      tier: "L1" | "L2",
      stale: boolean,
    ) => void | Promise<void>;
    onCacheMiss?: (key: string) => void | Promise<void>;
    onFetchError?: (key: string, error: Error) => void | Promise<void>;
    onInvalidation?: (
      key: string | null,
      tags: string[] | null,
    ) => void | Promise<void>;
  };
}

export interface ICache<T = any> {
  readonly name: string;
  get(key: string): Promise<T | null>;
  getOrFetch(key: string, opts?: CacheFetchOptions<T>): Promise<T>;
  set(key: string, value: T, opts?: CacheSetOptions): Promise<void>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  getMany(keys: string[]): Promise<Record<string, T | null>>;
  getOrFetchMany(
    keys: string[],
    opts?: CacheFetchManyOptions<T>,
  ): Promise<Record<string, T>>;
  setMany(
    entries: Array<{ key: string; value: T; opts?: CacheSetOptions }>,
  ): Promise<CacheBatchResult>;
  deleteMany(keys: string[]): Promise<CacheBatchResult>;
  invalidate(key: string): Promise<void>;
  invalidatePrefix(prefix: string): Promise<number>;
  invalidateTags(tags: string[]): Promise<number>;
  invalidateAll(): Promise<number>;
  prime(key: string, value: T, opts?: CacheSetOptions): Promise<void>;
  refresh(key: string, opts?: CacheFetchOptions<T>): Promise<T>;
  stats(): Promise<CacheStats>;
  snapshot(): Promise<CacheSnapshot>;
}

export type CacheInvalidationMessage =
  | {
      type: "key";
      cacheName: string;
      version: number;
      key: string;
      sourceNode: string;
    }
  | {
      type: "prefix";
      cacheName: string;
      version: number;
      prefix: string;
      sourceNode: string;
    }
  | {
      type: "tags";
      cacheName: string;
      version: number;
      tags: string[];
      keys: string[];
      sourceNode: string;
    }
  | {
      type: "all";
      cacheName: string;
      version: number;
      sourceNode: string;
    };

export interface CacheModuleRuntimeOptions {
  nodeId: string;
  broadcastEnabled: boolean;
}
