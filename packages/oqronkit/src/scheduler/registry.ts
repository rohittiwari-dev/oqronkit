import type { CronDefinition } from "../engine/index.js";

/**
 * Internal pending registry for auto-registered cron definitions.
 * When `cron()` is called (at module load time), the definition is pushed here.
 * `OqronKit.init()` drains this registry and boots the SchedulerModule.
 *
 * Uses globalThis to guarantee a single shared array even when the module
 * is resolved through different paths (e.g. tsx source vs built dist).
 */
const GLOBAL_KEY = "__oqronkit_pending_crons__" as const;

type GlobalRegistry = typeof globalThis & {
  __oqronkit_pending_crons__?: CronDefinition[];
};

function _getPending(): CronDefinition[] {
  const g = globalThis as GlobalRegistry;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = [];
  }
  return g[GLOBAL_KEY];
}

/** @internal Called by cron() to auto-register a definition */
export function _registerCron(def: CronDefinition): void {
  _getPending().push(def);
}

/** @internal Called by OqronKit.init() to collect all auto-registered crons */
export function _drainPending(): CronDefinition[] {
  const pending = _getPending();
  return pending.splice(0);
}
