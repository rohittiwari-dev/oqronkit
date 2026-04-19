import type {
  IOqronModule,
  Logger
} from "../engine/index.js";
import { OqronContainer } from "../engine/index.js";
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

export interface CronModuleFactoryConfig extends SchedulerFactoryConfig {
  /** Raw module config passed to CronEngine constructor. */
  moduleConfig?: Record<string, unknown>;
}

export interface ScheduleModuleFactoryConfig extends SchedulerFactoryConfig {
  /** Raw module config passed to ScheduleEngine constructor. */
  moduleConfig?: Record<string, unknown>;
}

/**
 * Unified factory that encapsulates the boilerplate of:
 *   1. Draining the pending registry
 *   2. Merging global tags
 *   3. Constructing the engine
 *
 * This replaces the duplicated wiring in `index.ts` with a single entry point.
 * Can be used directly or as an optional helper — does NOT replace existing wiring.
 *
 * @example
 * ```ts
 * const cron = createCronModule({ logger, environment: "production", globalTags: ["app:myservice"] });
 * OqronRegistry.getInstance().register(cron);
 * ```
 */
export function createCronModule(config: CronModuleFactoryConfig): IOqronModule {
  const definitions = _drainPending();
  applyGlobalTags(definitions, config.globalTags);

  return new CronEngine(
    definitions,
    config.logger,
    config.environment,
    config.project,
    config.moduleConfig as any,
    config.container,
  );
}

/**
 * Factory for the ScheduleEngine — mirrors `createCronModule` for schedule definitions.
 */
export function createScheduleModule(config: ScheduleModuleFactoryConfig): IOqronModule {
  const definitions = _drainPendingSchedules();
  applyGlobalTags(definitions, config.globalTags);

  return new ScheduleEngine(
    definitions,
    config.logger,
    config.environment,
    config.project,
    config.moduleConfig as any,
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
