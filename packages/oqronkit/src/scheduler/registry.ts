import type { CronDefinition } from "../engine/index.js";

/**
 * Internal pending registry for auto-registered cron definitions.
 * When `cron()` is called (at module load time), the definition is pushed here.
 * `OqronKit.init()` drains this registry and boots the CronEngine.
 *
 * Uses a Symbol key on globalThis to guarantee collision-free storage,
 * even when multiple OqronKit versions coexist in a monorepo.
 */
const GLOBAL_KEY = Symbol.for("oqronkit:pending_crons");

type GlobalRegistry = typeof globalThis & {
  [key: symbol]: CronDefinition[] | undefined;
};

function _getPending(): CronDefinition[] {
  const g = globalThis as unknown as GlobalRegistry;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = [];
  }
  return g[GLOBAL_KEY]!;
}

/** @internal Called by cron() to auto-register a definition */
export function _registerCron(def: CronDefinition): void {
  const pending = _getPending();
  const existingIndex = pending.findIndex((item) => item.name === def.name);
  if (existingIndex >= 0) pending.splice(existingIndex, 1, def);
  else pending.push(def);
}

/** @internal Called by OqronKit.init() to collect all auto-registered crons */
export function _drainPending(): CronDefinition[] {
  const pending = _getPending();
  return pending.splice(0);
}
