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

  get duration(): number {
    return Date.now() - this.startedLocalAt;
  }
}
