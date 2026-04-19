import type { ScheduleDefinition } from "../engine/index.js";

/**
 * Internal pending registry for auto-registered schedule definitions.
 * Uses a Symbol key on globalThis to prevent collisions in monorepo environments.
 */
const GLOBAL_KEY = Symbol.for("oqronkit:pending_schedules");

type GlobalRegistry = typeof globalThis & {
  [key: symbol]: ScheduleDefinition[] | undefined;
};

function _getPending(): ScheduleDefinition[] {
  const g = globalThis as unknown as GlobalRegistry;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = [];
  }
  return g[GLOBAL_KEY]!;
}

/** @internal Called by schedule() to auto-register a definition */
export function _registerSchedule(def: ScheduleDefinition): void {
  _getPending().push(def);
}

/** @internal Called by OqronKit.init() to collect all auto-registered schedules */
export function _drainPendingSchedules(): ScheduleDefinition[] {
  const pending = _getPending();
  return pending.splice(0);
}
