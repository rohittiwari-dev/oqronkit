import type { CronDefinition } from "@chronoforge/core";

/**
 * Internal pending registry for auto-registered cron definitions.
 * When `cron()` is called (at module load time), the definition is pushed here.
 * `ChronoForge.init()` drains this registry and boots the SchedulerModule.
 */
const _pending: CronDefinition[] = [];

/** @internal Called by cron() to auto-register a definition */
export function _registerCron(def: CronDefinition): void {
  _pending.push(def);
}

/** @internal Called by ChronoForge.init() to collect all auto-registered crons */
export function _drainPending(): CronDefinition[] {
  return _pending.splice(0);
}
