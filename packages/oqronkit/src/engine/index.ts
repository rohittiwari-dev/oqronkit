// ── Engine Core (Singletons) ─────────────────────────────────────────────────

// ── Config ───────────────────────────────────────────────────────────────────
export { loadConfig } from "./config/config-loader.js";
export { reconfigureConfig } from "./config/default-config.js";
export { defineConfig } from "./config/define-config.js";
export type { ValidatedConfig } from "./config/schema.js";
export { OqronConfigSchema } from "./config/schema.js";
// ── DI Container ─────────────────────────────────────────────────────────────
export { OqronContainer } from "./container.js";
// ── Context ──────────────────────────────────────────────────────────────────
export type { ICronContext } from "./context/cron-context.interface.js";
export type { CronContextOptions } from "./context/cron-context.js";
export { CronContext } from "./context/cron-context.js";
export type { BaseJobContextOptions } from "./context/job-context.js";
export { JobContext } from "./context/job-context.js";
export type { ScheduleContextOptions } from "./context/schedule-context.js";
export { ScheduleContext } from "./context/schedule-context.js";
export { Broker, initEngine, Lock, Storage, stopEngine } from "./core.js";

// ── Errors ───────────────────────────────────────────────────────────────────
export { OqronError } from "./errors/base.error.js";

// ── Events ───────────────────────────────────────────────────────────────────
export { OqronEventBus } from "./events/event-bus.js";

// ── Circuit Breaker ──────────────────────────────────────────────────────────
export { LagMonitor } from "./lag-monitor.js";

// ── Logger (voltlog-io) ──────────────────────────────────────────────────────
export type {
  Logger,
  LogLevelName,
  OqronLoggerConfig,
} from "./logger/index.js";
export { createLogger } from "./logger/index.js";

// ── Registry ─────────────────────────────────────────────────────────────────
export { OqronRegistry } from "./registry.js";

// ── Types ────────────────────────────────────────────────────────────────────
export type {
  ClusteringConfig,
  OqronConfig,
  OqronStorageMode,
} from "./types/config.types.js";
export type {
  CronDefinition,
  CronHooks,
  EveryConfig,
  JobRecord,
  MissedFirePolicy,
  OverlapPolicy,
  RetryConfig,
} from "./types/cron.types.js";
export type {
  BrokerStrategy,
  IBrokerEngine,
  ILockAdapter,
  IStorageEngine,
  ListOptions,
} from "./types/engine.js";
export type {
  FlowJobNode,
  JobFilter,
  JobLogEntry,
  JobStatus,
  JobStepEntry,
  JobTimelineEntry,
  JobTriggerSource,
  JobType,
  KeepJobs,
  OqronJob,
  OqronJobOptions,
  RemoveOnConfig,
  SystemStats,
} from "./types/job.types.js";
export type { IOqronModule } from "./types/module.types.js";
export type {
  IScheduleContext,
  ScheduleDefinition,
  ScheduleHooks,
  ScheduleRecurring,
  ScheduleRunAfter,
} from "./types/scheduler.types.js";
export type { BackoffOptions } from "./utils/backoffs.js";
// ── Utilities ────────────────────────────────────────────────────────────────
export { calculateBackoff, normalizeBackoff } from "./utils/backoffs.js";
export { DependencyResolver } from "./utils/dependency-resolver.js";
export {
  keepHistoryToRemoveConfig,
  pruneAfterCompletion,
} from "./utils/job-retention.js";
