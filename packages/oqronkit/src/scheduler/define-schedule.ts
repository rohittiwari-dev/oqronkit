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
import type { DisabledBehavior } from "../engine/types/config.types.js";
import { _registerSchedule } from "./registry-schedule.js";

/** Internal extension for dynamic definitions that carry a baseName */
interface InternalScheduleDefinition extends ScheduleDefinition {
  baseName?: string;
}

type EnqueueOptions<TPayload> = {
  runAt?: Date;
  runAfter?: ScheduleRunAfter;
  recurring?: ScheduleRecurring;
  rrule?: string;
  every?: { weeks?: number; days?: number; minutes?: number; hours?: number; seconds?: number };
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
  every?: { weeks?: number; days?: number; minutes?: number; hours?: number; seconds?: number };
  timezone?: string;
  missedFire?: MissedFirePolicy;
  overlap?: OverlapPolicy;
  guaranteedWorker?: boolean;
  heartbeatMs?: number;
  lockTtlMs?: number;
  timeout?: number;
  tags?: string[];
  /** Override global history rolling. `true` = infinite, `false` = none, `number` = max retained jobs. */
  keepHistory?: boolean | number;
  /** Keep specific bounded history length for failed jobs */
  keepFailedHistory?: boolean | number;
  condition?: (ctx: IScheduleContext<TPayload>) => Promise<boolean> | boolean;
  handler: (ctx: IScheduleContext<TPayload>) => Promise<unknown>;
  hooks?: ScheduleHooks<TPayload>;
  payload?: TPayload;
  retries?: RetryConfig;
  maxConcurrent?: number;
  status?: "active" | "paused";
  /**
   * Behavior when this schedule fires while disabled/paused.
   * Overrides the module-level setting.
   * @default "hold"
   */
  disabledBehavior?: DisabledBehavior;
  /** Schema version — bump to trigger config migration while preserving operational state. */
  version?: number;
  /** Execution priority. Lower = fires first when multiple schedules are due simultaneously. @default 0 */
  priority?: number;
  /** Random jitter (ms) added to nextRunAt to prevent thundering herd. @default 0 */
  jitterMs?: number;
  /** Optional rate limiter. If check() returns { allowed: false }, fire is skipped. */
  rateLimiter?: { check(ctx: any): Promise<{ allowed: boolean }> };
};

/** Minimal interface for the attached ScheduleEngine instance. */
interface IScheduleEngineRef {
  registerDynamic(def: ScheduleDefinition): Promise<void>;
  cancel(name: string): Promise<void>;
}

// Global reference that the engine will attach at boot time
// so that `trigger()` and `schedule()` work.
const engineRef: { current: IScheduleEngineRef | null } = { current: null };

export function _attachScheduleEngine(engine: IScheduleEngineRef | null) {
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
    keepHistory: options.keepHistory,
    keepFailedHistory: options.keepFailedHistory,
    condition: options.condition,
    handler: options.handler,
    hooks: options.hooks,
    payload: options.payload,
    retries: options.retries,
    maxConcurrent: options.maxConcurrent,
    status: options.status,
    disabledBehavior: options.disabledBehavior,
    version: options.version,
    priority: options.priority,
    jitterMs: options.jitterMs,
    rateLimiter: options.rateLimiter,
  };

  _registerSchedule(def as ScheduleDefinition<unknown>);

  /**
   * Shared enqueue logic for both trigger() and schedule().
   * @param defaultImmediate If true and no timing opts are provided, defaults to runAt: new Date()
   */
  const _enqueue = async (opts: EnqueueOptions<TPayload> | undefined, defaultImmediate: boolean) => {
    if (!engineRef.current) {
      throw new Error(
        `[OqronKit] Cannot enqueue "${options.name}" — ScheduleEngine is not running.`,
      );
    }

    const dynamicDef: InternalScheduleDefinition = { ...def } as InternalScheduleDefinition;
    if (opts) {
      if (opts.runAt) dynamicDef.runAt = opts.runAt;
      if (opts.runAfter) dynamicDef.runAfter = opts.runAfter;
      if (opts.recurring) dynamicDef.recurring = opts.recurring;
      if (opts.rrule) dynamicDef.rrule = opts.rrule;
      if (opts.every) dynamicDef.every = opts.every;
      if (opts.payload) dynamicDef.payload = opts.payload;
    }

    // SAFETY: Always isolate dynamic triggers from the base singleton.
    const suffix = opts?.nameSuffix ?? `dyn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dynamicDef.name = `${def.name}:${suffix}`;
    dynamicDef.baseName = def.name;

    // If defaultImmediate and no explicit timing is provided, fire now
    if (
      defaultImmediate &&
      !opts?.runAt &&
      !opts?.runAfter &&
      !opts?.recurring &&
      !opts?.rrule &&
      !opts?.every
    ) {
      dynamicDef.runAt = new Date();
    }

    await engineRef.current.registerDynamic(dynamicDef);
  };

  return {
    ...def,
    trigger: (opts?: EnqueueOptions<TPayload>) => _enqueue(opts, true),
    schedule: (opts?: EnqueueOptions<TPayload>) => _enqueue(opts, false),
    cancel: async () => {
      if (!engineRef.current) return;
      await engineRef.current.cancel(def.name);
    },
  };
};
