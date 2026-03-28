import type { ChronoLoggerConfig } from "../logger/index.js";
import type { IChronoAdapter } from "./db.types.js";
import type { ILockAdapter } from "./lock.types.js";

export type DbAdapterType =
  | "sqlite"
  | "memory"
  | "postgres"
  | "mysql"
  | "mongodb"
  | "redis";
export type LockAdapterType = "db" | "memory" | "redis";

export interface ChronoConfig {
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
   * The primary database adapter (State Store).
   * Union of explicit DI or declarative config.
   */
  db?:
    | IChronoAdapter
    | {
        adapter: DbAdapterType;
        url?: string;
        poolMin?: number;
        poolMax?: number;
        tablePrefix?: string;
        migrations?: "auto" | "manual" | false;
        ssl?: boolean;
      };

  /**
   * The distributed lock adapter for safe concurrency.
   * Union of explicit DI or declarative config.
   */
  lock?:
    | ILockAdapter
    | {
        adapter: LockAdapterType;
        url?: string;
        ttl?: number;
        retryDelay?: number;
        retryCount?: number;
      };

  /**
   * The high-throughput message broker (optional, for PubSub/Queueing at scale)
   */
  broker?: any;

  /**
   * List of core modules to enable.
   * e.g. ['cron', 'queue', 'workflow', 'batch', 'webhook', 'pipeline']
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

  /**
   * Module-specific configs
   */
  cron?: {
    enable?: boolean;
    timezone?: string;
    tickInterval?: number;
    missedFirePolicy?: "skip" | "run-once" | "run-all";
    maxConcurrentJobs?: number;
    leaderElection?: boolean;
  };

  scheduler?: {
    enable?: boolean;
    tickInterval?: number;
  };

  /**
   * Directory to auto-discover job definition files from.
   * ChronoForge.init() scans this directory recursively for .ts/.js files
   * that export definitions and registers them automatically.
   * @default "./src/jobs"
   */
  jobsDir?: string;

  /**
   * Global tags applied to every job processed by this node.
   * @default []
   */
  tags?: string[];

  /**
   * Worker-level configurations
   */
  worker?: {
    /** Number of concurrent jobs this node processes simultaneously */
    concurrency?: number;
    /** Time in ms to wait for active jobs before SIGTERM exits */
    gracefulShutdownMs?: number;
  };

  /**
   * Logger configuration (powered by voltlog-io).
   * Set to `false` to disable logging entirely.
   */
  logger?: ChronoLoggerConfig | false;

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
   * Graceful shutdown configuration
   */
  shutdown?: {
    enabled?: boolean;
    timeout?: number;
    signals?: string[];
  };
}
