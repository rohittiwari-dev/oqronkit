import type { ScheduleDefinition } from "../engine/index.js";

const GLOBAL_KEY = "__oqronkit_pending_schedules__" as const;

type GlobalRegistry = typeof globalThis & {
  __oqronkit_pending_schedules__?: ScheduleDefinition[];
};

function _getPending(): ScheduleDefinition[] {
  const g = globalThis as GlobalRegistry;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = [];
  }
  return g[GLOBAL_KEY];
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
