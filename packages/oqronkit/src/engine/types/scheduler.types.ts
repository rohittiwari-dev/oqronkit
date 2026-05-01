import type { DisabledBehavior } from "./config.types.js";
import type {
  MissedFirePolicy,
  OverlapPolicy,
  RetryConfig,
} from "./cron.types.js";

// -- Schedule Engine Type Definitions --

export interface ScheduleRecurring {
  frequency: "daily" | "weekly" | "monthly" | "yearly";
  dayOfMonth?: number;
  at?: { hour: number; minute: number };
  months?: number[]; // e.g. [1, 4, 7, 10]
}

export interface ScheduleRunAfter {
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
}

export interface ScheduleHooks<TPayload = unknown> {
  beforeRun?: (ctx: IScheduleContext<TPayload>) => Promise<void> | void;
  afterRun?: (
    ctx: IScheduleContext<TPayload>,
    result: unknown,
  ) => Promise<void> | void;
  onError?: (
    ctx: IScheduleContext<TPayload>,
    error: Error,
  ) => Promise<boolean | void> | boolean | void;
  onMissedFire?: (
    ctx: IScheduleContext<TPayload>,
    missedAt: Date,
  ) => Promise<void> | void;
}

export interface IScheduleContext<TPayload = unknown> {
  /** Unique run identifier */
  readonly id: string;
  /** Schedule definition name */
  readonly name: string;
  /** @alias name — backward compat with ICronContext */
  readonly scheduleName: string;
  readonly firedAt: Date;
  readonly payload: TPayload;
  readonly duration: number;
  /** Abort signal — allows cooperative cancellation */
  readonly signal: AbortSignal;
  /** Whether the signal has been aborted */
  readonly aborted: boolean;
  readonly environment?: string;
  readonly project?: string;
  log(level: string, message: string, meta?: Record<string, unknown>): void;
  progress(percent: number, label?: string): void;
  getProgress(): number;
}

export interface ScheduleDefinition<TPayload = unknown> {
  name: string;
  /** Schema version — bump when changing schedule config to trigger a controlled migration. */
  version?: number;

  // Schedule configurations
  runAt?: Date;
  /** Repeating relative interval. For one-shot delayed schedules, use runAt. */
  runAfter?: ScheduleRunAfter;
  recurring?: ScheduleRecurring;
  rrule?: string;
  every?: { weeks?: number; days?: number; minutes?: number; hours?: number; seconds?: number };

  // Execution Logic
  timezone?: string;
  missedFire?: MissedFirePolicy;
  /** Maximum occurrences replayed for missedFire="run-all". Default: 100. */
  maxMissedRuns?: number;
  overlap?: OverlapPolicy;
  guaranteedWorker?: boolean;
  heartbeatMs?: number;
  lockTtlMs?: number;
  timeout?: number;
  tags?: string[];
  /** Override global history rolling. `true` = infinite, `false` = none, `number` = max retained jobs. */
  keepHistory?: boolean | number;
  /** Keep specific bounded history length for failed jobs overriding general logic */
  keepFailedHistory?: boolean | number;

  condition?: (ctx: IScheduleContext<TPayload>) => Promise<boolean> | boolean;
  handler: (ctx: IScheduleContext<TPayload>) => Promise<unknown>;
  hooks?: ScheduleHooks<TPayload>;
  retries?: RetryConfig;

  // Statically defining a task vs. runtime payloads payload (Optional defaults)
  payload?: TPayload;
  status?: "active" | "paused";
  maxConcurrent?: number;
  /**
   * Behavior when this schedule fires while disabled/paused.
   * Overrides the module-level `disabledBehavior` if set.
   * @default "hold"
   */
  disabledBehavior?: DisabledBehavior;
  /**  Execution priority when multiple schedules fire simultaneously. Lower = higher priority. Default: 0. */
  priority?: number;
  /**  Random jitter in ms added to nextRunAt to prevent thundering herd. Default: 0. */
  jitterMs?: number;
  /**  Optional rate limiter. If check() returns { allowed: false }, fire is skipped. */
  rateLimiter?: { check(ctx: any): Promise<{ allowed: boolean }> };
}

