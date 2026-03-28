import type { ScheduleDefinition } from "../core/index.js";

const GLOBAL_KEY = "__oqronkit_pending_schedules__" as const;

function _getPending(): ScheduleDefinition[] {
  if (!(globalThis as any)[GLOBAL_KEY]) {
    (globalThis as any)[GLOBAL_KEY] = [];
  }
  return (globalThis as any)[GLOBAL_KEY];
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
