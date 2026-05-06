import type {
  DisabledBehavior,
  IOqronModule,
  Logger,
  OqronContainer,
} from "../engine/index.js";
import { CronEngine } from "./cron-engine.js";
import { _drainPending } from "./registry.js";
import { _drainPendingSchedules } from "./registry-schedule.js";
import { ScheduleEngine } from "./schedule-engine.js";

/**
 * Configuration shape expected by the registry factory.
 * Aligned with the module config types from `modules.ts`.
 */
export interface SchedulerFactoryConfig {
  /** Tags to merge into all definitions. */
  globalTags?: string[];
  environment?: string;
  project?: string;
  logger?: Logger;
  container?: OqronContainer;
}

/** Typed config matching CronEngine constructor's config parameter */
export interface CronModuleConfig {
  enable?: boolean;
  timezone?: string;
  tickInterval?: number;
  leaderElection?: boolean;
  keepJobHistory?: boolean | number;
  keepFailedJobHistory?: boolean | number;
  shutdownTimeout?: number;
  lagMonitor?: { maxLagMs?: number; sampleIntervalMs?: number };
  disabledBehavior?: DisabledBehavior;
  maxHeldJobs?: number;
}

/** Typed config matching ScheduleEngine constructor's config parameter */
export interface ScheduleModuleConfig extends CronModuleConfig {
  clustering?: {
    totalShards?: number;
    ownedShards?: number[];
    region?: string;
  };
}

export interface CronModuleFactoryConfig extends SchedulerFactoryConfig {
  moduleConfig?: CronModuleConfig;
}

export interface ScheduleModuleFactoryConfig extends SchedulerFactoryConfig {
  moduleConfig?: ScheduleModuleConfig;
}

/**
 * Unified factory that encapsulates the boilerplate of:
 *   - Draining the pending registry
 *   - Merging global tags
 *   - Constructing the engine
 *
 * @example
 * ```ts
 * const cron = createCronModule({ logger, environment: "production", globalTags: ["app:myservice"] });
 * OqronRegistry.getInstance().register(cron);
 * ```
 */
export function createCronModule(
  config: CronModuleFactoryConfig,
): IOqronModule {
  const definitions = _drainPending();
  applyGlobalTags(definitions, config.globalTags);

  return new CronEngine(
    definitions,
    config.logger,
    config.environment,
    config.project,
    config.moduleConfig,
    config.container,
  );
}

/**
 * Factory for the ScheduleEngine — mirrors `createCronModule` for schedule definitions.
 */
export function createScheduleModule(
  config: ScheduleModuleFactoryConfig,
): IOqronModule {
  const definitions = _drainPendingSchedules();
  applyGlobalTags(definitions, config.globalTags);

  return new ScheduleEngine(
    definitions,
    config.logger,
    config.environment,
    config.project,
    config.moduleConfig,
    config.container,
  );
}

/** Merges global tags into each definition without duplicates. */
function applyGlobalTags(
  definitions: Array<{ tags?: string[] }>,
  globalTags?: string[],
): void {
  if (!globalTags?.length) return;
  for (const def of definitions) {
    def.tags = [...new Set([...(def.tags ?? []), ...globalTags])];
  }
}
