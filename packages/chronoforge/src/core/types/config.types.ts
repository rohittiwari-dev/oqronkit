import type { ChronoLoggerConfig } from "../logger/index.js";
import type { IChronoAdapter } from "./db.types.js";
import type { ILockAdapter } from "./lock.types.js";

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
   * Required. Instantiate via ../../db/index.js.
   */
  db: IChronoAdapter;

  /**
   * The distributed lock adapter for safe concurrency.
   * Required. Instantiate via ../../lock/index.js.
   */
  lock: ILockAdapter;

  /**
   * The high-throughput message broker (optional, for PubSub/Queueing at scale)
   */
  broker?: any;

  /**
   * List of core modules to enable.
   * e.g. ['cron', 'queue', 'workflow', 'batch', 'webhook', 'pipeline']
   * @default []
   */
  modules?: string[];

  /**
   * Directory to auto-discover job definition files from.
   * ChronoForge.init() scans this directory recursively for .ts/.js files
   * that export CronDefinitions (via `cron()`) and registers them automatically.
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
}
