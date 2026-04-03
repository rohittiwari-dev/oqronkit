import type { OqronLoggerConfig } from "../logger/index.js";
import type { BrokerStrategy } from "./engine.js";
import type { RemoveOnConfig } from "./job.types.js";

export type RedisLike =
  | {
      url: string;
      password?: string;
      db?: number;
      tls?: boolean;
      [key: string]: any;
    }
  | any; // Escape hatch for direct ioredis passing

/** Clustering config for sharded leader election across geo-regions */
export interface ClusteringConfig {
  /** Total shards across all regions. @default 1 (single leader) */
  totalShards?: number;
  /** Shards this node is eligible to claim. @default [0] */
  ownedShards?: number[];
  /** Region identifier for logging. @default "default" */
  region?: string;
}

/**
 * Storage mode controls which adapter combination is used.
 *
 * - `"default"` — Everything in-memory. Single-process, no external dependencies.
 * - `"db"`      — PostgreSQL required. Storage + Broker + Lock all via PG.
 * - `"redis"`   — Redis required. Storage + Broker + Lock all via Redis.
 * - `"hybrid-db"` — Both PG + Redis required. PG for durable Storage, Redis for fast Broker + Lock.
 */
export type OqronStorageMode = "default" | "db" | "redis" | "hybrid-db";

export interface OqronConfig {
  /**
   * The name of this project/service (e.g. 'acme-billing-svc')
   */
  project?: string;

  /**
   * Environment isolation.
   * Workers in 'development' will never execute jobs enqueued in 'production'.
   * @default "development"
   */
  environment?: string;

  /**
   * Storage mode. Controls which combination of adapters is used.
   *
   * - `"default"` (default) — Everything in-memory (single-process monolith)
   * - `"db"` — PostgreSQL for all adapters. Requires `postgres` config.
   * - `"redis"` — Redis for all adapters. Requires `redis` config.
   * - `"hybrid-db"` — PG for storage, Redis for broker + lock. Requires both `postgres` and `redis`.
   *
   * @default "default"
   */
  mode?: OqronStorageMode;

  /**
   * Primary Redis connection.
   * Required when `mode` is `"redis"` or `"hybrid-db"`.
   */
  redis?: RedisLike;

  /**
   * PostgreSQL connection configuration.
   * Required when `mode` is `"db"` or `"hybrid-db"`.
   */
  postgres?: {
    /** Connection string (e.g. 'postgresql://user:pass@host:5432/db') */
    connectionString: string;
    /** Table name prefix. @default "oqron" */
    tablePrefix?: string;
    /** Connection pool size. @default 10 */
    poolSize?: number;
  };

  /**
   * List of core modules to enable.
   * @default []
   */
  modules?: (
    | "cron"
    | "scheduler"
    | "queue"
    | "workflow"
    | "batch"
    | "webhook"
    | "pipeline"
  )[];

  // ── Module-specific configs ─────────────────────────────────────────────

  cron?: {
    /** Enable/disable the cron module. @default true */
    enable?: boolean;
    /** Global timezone fallback when a cron def doesn't specify one. @default "UTC" */
    timezone?: string;
    /** Tick interval in ms for the cron polling loop. @default 1000 */
    tickInterval?: number;
    /** Default missed-fire policy when not set on the definition. @default "run-once" */
    missedFirePolicy?: "skip" | "run-once" | "run-all";
    /** Global max concurrent cron jobs (per-def can override). @default 5 */
    maxConcurrentJobs?: number;
    /** Enable cluster-wide leader election for cron ticks. @default true */
    leaderElection?: boolean;
    /** Rolling execution history. `true` = infinite, `false` = 0, `number` = keep N */
    keepJobHistory?: boolean | number;
    /** Override for failed tasks retention */
    keepFailedJobHistory?: boolean | number;
    /** Graceful shutdown drain timeout in ms. @default 25000 */
    shutdownTimeout?: number;
    /** Lag monitor thresholds */
    lagMonitor?: { maxLagMs?: number; sampleIntervalMs?: number };
    /** Sharded leader election for multi-region cron distribution */
    clustering?: ClusteringConfig;
  };

  scheduler?: {
    /** Enable/disable the scheduler module. @default true */
    enable?: boolean;
    /** Tick interval in ms. @default 1000 */
    tickInterval?: number;
    /** Global timezone fallback. @default "UTC" */
    timezone?: string;
    /** Enable cluster-wide leader election. @default true */
    leaderElection?: boolean;
    /** Rolling execution history retention */
    keepJobHistory?: boolean | number;
    /** Failed job history retention */
    keepFailedJobHistory?: boolean | number;
    /** Graceful shutdown drain timeout in ms. @default 25000 */
    shutdownTimeout?: number;
    /** Lag monitor thresholds */
    lagMonitor?: { maxLagMs?: number; sampleIntervalMs?: number };
    /** Sharded leader election for multi-region schedule distribution */
    clustering?: ClusteringConfig;
  };

  queue?: {
    /** Parallel execution limit. @default 5 */
    concurrency?: number;
    /** Polling interval in ms. @default 5000 */
    heartbeatMs?: number;
    /** Lock TTL in ms for crash recovery. @default 30000 */
    lockTtlMs?: number;
    /** Job ordering strategy. @default "fifo" */
    strategy?: BrokerStrategy;
    /** Default retry configuration for all queues */
    retries?: {
      max?: number;
      strategy?: "fixed" | "exponential";
      baseDelay?: number;
      maxDelay?: number;
    };
    /** Dead letter queue configuration */
    deadLetter?: { enabled?: boolean };
    /** Global default: auto-remove completed jobs. @default false */
    removeOnComplete?: RemoveOnConfig;
    /** Global default: auto-remove failed jobs. @default false */
    removeOnFail?: RemoveOnConfig;
    /** Graceful shutdown drain timeout in ms. @default 25000 */
    shutdownTimeout?: number;
    /** Max stalled job retries before marking as permanently failed. @default 1 */
    maxStalledCount?: number;
    /** Stalled check interval in ms. @default 30000 */
    stalledInterval?: number;
  };

  /**
   * Directory to auto-discover job definition files from.
   * @default "./src/jobs"
   */
  jobsDir?: string;

  /**
   * Global tags applied to every job processed by this node.
   * @default []
   */
  tags?: string[];

  /**
   * Logger configuration (powered by voltlog-io).
   * Set to `false` to disable logging entirely.
   */
  logger?: OqronLoggerConfig | false;

  /**
   * Telemetry configuration
   */
  telemetry?: {
    prometheus?: {
      enabled?: boolean;
      path?: string;
    };
    opentelemetry?: {
      enabled?: boolean;
    };
  };

  /**
   * Observability configuration (Log & Timeline Settings)
   */
  observability?: {
    /** Max number of log entries per job record. Default: 200 */
    maxJobLogs?: number;
    /** Max number of timeline entries per job. Default: 20 */
    maxTimelineEntries?: number;
    /** Enable memory measurement on job completion. Default: true */
    trackMemory?: boolean;
    /** Enable the log collector for category-level log views. Default: true */
    logCollector?: boolean;
    /** Max entries in the global log collector buffer. Default: 500 */
    logCollectorMaxGlobal?: number;
    /** Max entries per queue/schedule in log collector. Default: 200 */
    logCollectorMaxPerCategory?: number;
  };

  /**
   * Oqron UI Dashboard configuration
   */
  ui?: {
    enabled?: boolean;
    auth?: {
      username?: string;
      password?: string;
    };
    /**
     * Data retention policy surfaced to the dashboard.
     * Controls how long run history, events, and metrics are kept.
     * Values like "7d", "30d", "unlimited".
     */
    retention?: {
      runs?: string;
      events?: string;
      metrics?: string;
    };
  };

  /**
   * Graceful shutdown configuration
   */
  shutdown?: {
    enabled?: boolean;
    timeout?: number;
    signals?: string[];
  };
}
