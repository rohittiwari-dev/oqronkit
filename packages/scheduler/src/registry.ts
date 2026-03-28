import type { CronDefinition } from "@chronoforge/core";

/**
 * Internal pending registry for auto-registered cron definitions.
 * When `cron()` is called (at module load time), the definition is pushed here.
 * `ChronoForge.init()` drains this registry and boots the SchedulerModule.
 *
 * Uses globalThis to guarantee a single shared array even when the module
 * is resolved through different paths (e.g. tsx source vs built dist).
 */
const GLOBAL_KEY = "__chronoforge_pending_crons__" as const;

function _getPending(): CronDefinition[] {
  if (!(globalThis as any)[GLOBAL_KEY]) {
    (globalThis as any)[GLOBAL_KEY] = [];
  }
  return (globalThis as any)[GLOBAL_KEY];
}

/** @internal Called by cron() to auto-register a definition */
export function _registerCron(def: CronDefinition): void {
  _getPending().push(def);
}

/** @internal Called by ChronoForge.init() to collect all auto-registered crons */
export function _drainPending(): CronDefinition[] {
  const pending = _getPending();
  return pending.splice(0);
}
