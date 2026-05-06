import type { ICronContext } from "./cron-context.interface.js";
import { type BaseJobContextOptions, JobContext } from "./job-context.js";

export interface CronContextOptions extends BaseJobContextOptions {
  firedAt: Date;
  scheduleName: string;
}

// CronContext implements ICronContext — satisfies CronDefinition.handler signature at runtime
export class CronContext extends JobContext implements ICronContext {
  public readonly firedAt: Date;
  public readonly scheduleName: string;
  private readonly startedLocalAt: number;

  constructor(opts: CronContextOptions) {
    super(opts);
    this.firedAt = opts.firedAt;
    this.scheduleName = opts.scheduleName;
    this.startedLocalAt = Date.now();
  }

  /** Unified name field — alias for `scheduleName` (M8 parity with IScheduleContext) */
  get name(): string {
    return this.scheduleName;
  }

  get aborted(): boolean {
    return this.signal.aborted;
  }

  get duration(): number {
    return Date.now() - this.startedLocalAt;
  }
}
