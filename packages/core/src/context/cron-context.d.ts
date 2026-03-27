import { JobContext, type BaseJobContextOptions } from "./job-context.js";
import type { ICronContext } from "./cron-context.interface.js";
export interface CronContextOptions extends BaseJobContextOptions {
  firedAt: Date;
  scheduleName: string;
}
export declare class CronContext extends JobContext implements ICronContext {
  readonly firedAt: Date;
  readonly scheduleName: string;
  constructor(opts: CronContextOptions);
}
//# sourceMappingURL=cron-context.d.ts.map
