import type { OqronLoggerConfig } from "../logger/index.js";

/** Shared worker execution defaults — applies to taskQueue, worker, and all future modules */
export interface WorkerDefaults {
  concurrency?: number;
  heartbeatMs?: number;
  lockTtlMs?: number;
  retries?: {
    max?: number;
    strategy?: "fixed" | "exponential";
    baseDelay?: number;
    maxDelay?: number;
  };
  deadLetter?: { enabled?: boolean };
  limiter?: { max: number; duration: number; groupKey?: string };
}

export type DatabaseLike =
  | {
      adapter: "sqlite" | "postgres" | "mysql" | "memory";
      url?: string;
      [key: string]: any;
    }
  | any; // Escape hatch for direct driver passing

export type RedisLike =
  | {
      url: string;
      password?: string;
      db?: number;
      tls?: boolean;
      [key: string]: any;
    }
  | any; // Escape hatch for direct ioredis passing

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
   * Primary relational database connection.
   * Derives storage and optionally locking/broker if Redis is not present.
   */
  db?: DatabaseLike;

  /**
   * Primary Redis connection.
   * If provided, automatically handles fast-path operations (locking and message broker).
   */
  redis?: RedisLike;

  /**
   * List of core modules to enable.
   * e.g. ['cron', 'queue', 'workflow', 'batch', 'webhook', 'pipeline']
   * @default []
   */
  modules?: (
    | "cron"
    | "scheduler"
    | "taskQueue"
    | "queue"
    | "worker"
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
    /** Rolling execution history. `true` = infinite, `false` = 0, `number` = keep N */
    keepJobHistory?: boolean | number;
    /** Override for failed tasks. Handled explicitly under errors */
    keepFailedJobHistory?: boolean | number;
  };

  scheduler?: {
    enable?: boolean;
    tickInterval?: number;
    keepJobHistory?: boolean | number;
    keepFailedJobHistory?: boolean | number;
  };

  taskQueue?: {
    concurrency?: number;
    heartbeatMs?: number;
    lockTtlMs?: number;
    retries?: {
      max?: number;
      strategy?: "fixed" | "exponential";
      baseDelay?: number;
      maxDelay?: number;
    };
    deadLetter?: { enabled?: boolean };
  };

  queue?: {
    defaultTtl?: number;
    ack?: "leader" | "all" | "none";
  };

  worker?: {
    concurrency?: number;
    heartbeatMs?: number;
    lockTtlMs?: number;
    retries?: {
      max?: number;
      strategy?: "fixed" | "exponential";
      baseDelay?: number;
      maxDelay?: number;
    };
    deadLetter?: { enabled?: boolean };
  };

  /**
   * Directory to auto-discover job definition files from.
   * OqronKit.init() scans this directory recursively for .ts/.js files
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
   * Graceful shutdown configuration
   */
  shutdown?: {
    enabled?: boolean;
    timeout?: number;
    signals?: string[];
  };
}
