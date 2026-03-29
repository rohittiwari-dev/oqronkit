import type {
  IScheduleContext,
  MissedFirePolicy,
  OverlapPolicy,
  RetryConfig,
  ScheduleDefinition,
  ScheduleHooks,
  ScheduleRecurring,
  ScheduleRunAfter,
} from "../engine/index.js";
import { _registerSchedule } from "./registry-schedule.js";

type EnqueueOptions<TPayload> = {
  runAt?: Date;
  runAfter?: ScheduleRunAfter;
  recurring?: ScheduleRecurring;
  rrule?: string;
  every?: { minutes?: number; hours?: number; seconds?: number };
  payload?: TPayload;
  nameSuffix?: string; // Optional suffix for dynamic names (e.g. queue pattern)
};

export type ScheduleInstance<TPayload> = ScheduleDefinition<TPayload> & {
  trigger: (opts?: EnqueueOptions<TPayload>) => Promise<void>;
  schedule: (opts?: EnqueueOptions<TPayload>) => Promise<void>;
  // For static singletons
  cancel: () => Promise<void>;
};

export type DefineScheduleOptions<TPayload> = {
  name: string;
  runAt?: Date;
  runAfter?: ScheduleRunAfter;
  recurring?: ScheduleRecurring;
  rrule?: string;
  every?: { minutes?: number; hours?: number; seconds?: number };
  timezone?: string;
  missedFire?: MissedFirePolicy;
  overlap?: OverlapPolicy;
  guaranteedWorker?: boolean;
  heartbeatMs?: number;
  lockTtlMs?: number;
  timeout?: number;
  tags?: string[];
  condition?: (ctx: IScheduleContext<TPayload>) => Promise<boolean> | boolean;
  handler: (ctx: IScheduleContext<TPayload>) => Promise<unknown>;
  hooks?: ScheduleHooks<TPayload>;
  payload?: TPayload;
  retries?: RetryConfig;
  maxConcurrent?: number;
  status?: "active" | "paused";
};

// Global reference that the engine will attach at boot time
// so that `trigger()` and `schedule()` work.
const engineRef: { current: any } = { current: null };

export function _attachScheduleEngine(engine: any) {
  engineRef.current = engine;
}

/**
 * Define a schedule or a task.
 * Automatically registers it with OqronKit for boot-time loading.
 */
export const schedule = <TPayload = unknown>(
  options: DefineScheduleOptions<TPayload>,
): ScheduleInstance<TPayload> => {
  const def: ScheduleDefinition<TPayload> = {
    name: options.name,
    runAt: options.runAt,
    runAfter: options.runAfter,
    recurring: options.recurring,
    rrule: options.rrule,
    every: options.every,
    timezone: options.timezone,
    missedFire: options.missedFire ?? "skip",
    overlap: options.overlap ?? "skip",
    guaranteedWorker: options.guaranteedWorker ?? false,
    heartbeatMs: options.heartbeatMs,
    lockTtlMs: options.lockTtlMs,
    timeout: options.timeout,
    tags: options.tags ?? [],
    condition: options.condition,
    handler: options.handler,
    hooks: options.hooks,
    payload: options.payload,
    retries: options.retries,
    maxConcurrent: options.maxConcurrent,
    status: options.status,
  };

  _registerSchedule(def as ScheduleDefinition<unknown>);

  return {
    ...def,
    trigger: async (opts?: EnqueueOptions<TPayload>) => {
      // Dynamic triggering relies on the engine being alive
      if (!engineRef.current) {
        throw new Error(
          `[OqronKit] Cannot trigger "${options.name}" — ScheduleEngine is not running.`,
        );
      }

      const dynamicDef = { ...def };
      if (opts) {
        if (opts.nameSuffix) dynamicDef.name = `${def.name}:${opts.nameSuffix}`;
        if (opts.runAt) dynamicDef.runAt = opts.runAt;
        if (opts.runAfter) dynamicDef.runAfter = opts.runAfter;
        if (opts.recurring) dynamicDef.recurring = opts.recurring;
        if (opts.rrule) dynamicDef.rrule = opts.rrule;
        if (opts.every) dynamicDef.every = opts.every;
        if (opts.payload) dynamicDef.payload = opts.payload;
      }

      // Override default execution immediately if runAt isn't defined explicitly as future
      if (
        !opts?.runAt &&
        !opts?.runAfter &&
        !opts?.recurring &&
        !opts?.rrule &&
        !opts?.every
      ) {
        dynamicDef.runAt = new Date();
      }

      await engineRef.current.registerDynamic(dynamicDef);
    },
    schedule: async (opts?: EnqueueOptions<TPayload>) => {
      if (!engineRef.current) {
        throw new Error(
          `[OqronKit] Cannot schedule "${options.name}" — ScheduleEngine is not running.`,
        );
      }

      const dynamicDef = { ...def };
      if (opts) {
        if (opts.nameSuffix) dynamicDef.name = `${def.name}:${opts.nameSuffix}`;
        if (opts.runAt) dynamicDef.runAt = opts.runAt;
        if (opts.runAfter) dynamicDef.runAfter = opts.runAfter;
        if (opts.recurring) dynamicDef.recurring = opts.recurring;
        if (opts.rrule) dynamicDef.rrule = opts.rrule;
        if (opts.every) dynamicDef.every = opts.every;
        if (opts.payload) dynamicDef.payload = opts.payload;
      }
      await engineRef.current.registerDynamic(dynamicDef);
    },
    cancel: async () => {
      if (!engineRef.current) return;
      await engineRef.current.cancel(def.name);
    },
  };
};
