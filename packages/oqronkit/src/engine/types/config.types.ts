import type { OqronModuleInput } from "../../modules.js";
import type { OqronLoggerConfig } from "../logger/index.js";

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
   * List of modules to enable. Supports multiple input forms:
   *
   * - String shorthand: `"cron"`, `"queue"`, `"scheduler"`
   * - Inline object: `{ module: "cron", tickInterval: 500 }`
   * - Factory reference: `cronModule` (uses defaults)
   * - Factory invocation: `cronModule({ tickInterval: 500 })`
   *
   * If a module is not in this list, it will not boot.
   * @default []
   */
  modules?: OqronModuleInput[];

  /**
   * Directory to auto-discover trigger/job definition files (scanned recursively).
   *
   * - `string` — explicit path relative to cwd (e.g. `"./src/triggers"`)
   * - `false`  — disable auto-discovery entirely (use manual imports)
   * - omitted  — auto-detect common directories: `triggers/`, `jobs/`, `src/triggers/`, `src/jobs/`
   */
  triggers?: string | false;

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
