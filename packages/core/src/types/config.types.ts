import type { IChronoAdapter } from "./db.types.js";
import type { ILockAdapter } from "./lock.types.js";

export type IModulesName =
  | "cron"
  | "queue"
  | "workflow"
  | "batch"
  | "webhook"
  | "pipeline";

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
   * The primary database adapter (State Store) used for job tracking and persistence.
   * Required. Usually instantiated via @chronoforge/db.
   */
  db: IChronoAdapter;

  /**
   * The distributed lock adapter used to guarantee safe concurrency across workers.
   * Required. Usually instantiated via @chronoforge/lock.
   */
  lock: ILockAdapter;

  /**
   * The high-throughput message broker (optional, for PubSub/Queueing at scale)
   */
  broker?: any;

  /**
   * List of core modules to enable on this node.
   * e.g. ['cron', 'queue', 'workflow', 'batch', 'webhook', 'pipeline']
   * @default []
   */
  modules?: IModulesName[];

  /**
   * Global tags applied to every job processed by this node. Useful for
   * filtering in the UI Dashboard (e.g., ['billing-core', 'aws-us-east-1']).
   * @default []
   */
  tags?: string[];

  /**
   * Worker-level configurations
   */
  worker?: {
    /** Number of concurrent jobs this node is allowed to process simultaneously */
    concurrency?: number;
    /** Time in ms to wait for active jobs to safely complete before SIGTERM exits */
    gracefulShutdownMs?: number;
  };

  /**
   * Internal logger settings
   */
  logger?: {
    level?: "debug" | "info" | "warn" | "error";
  };
}
