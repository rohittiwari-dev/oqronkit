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
  ) => Promise<void> | void;
  onMissedFire?: (
    ctx: IScheduleContext<TPayload>,
    missedAt: Date,
  ) => Promise<void> | void;
}

export interface IScheduleContext<TPayload = unknown> {
  name: string;
  firedAt: Date;
  payload: TPayload;
  duration: number;
  log(level: string, message: string, meta?: Record<string, unknown>): void;
  progress(percent: number, label?: string): void;
}

export interface ScheduleDefinition<TPayload = unknown> {
  name: string;

  // Schedule configurations
  runAt?: Date;
  runAfter?: ScheduleRunAfter;
  recurring?: ScheduleRecurring;
  rrule?: string;
  every?: { minutes?: number; hours?: number; seconds?: number };

  // Execution Logic
  timezone?: string;
  missedFire: MissedFirePolicy;
  overlap: OverlapPolicy;
  guaranteedWorker?: boolean;
  heartbeatMs?: number;
  lockTtlMs?: number;
  timeout?: number;
  tags: string[];

  condition?: (ctx: IScheduleContext<TPayload>) => Promise<boolean> | boolean;
  handler: (ctx: IScheduleContext<TPayload>) => Promise<unknown>;
  hooks?: ScheduleHooks<TPayload>;
  retries?: RetryConfig;

  // Statically defining a task vs. runtime payloads payload (Optional defaults)
  payload?: TPayload;
}
