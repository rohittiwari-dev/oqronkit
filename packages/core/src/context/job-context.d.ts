import type { ChronoLogger } from "../logger/voltlog.js";
export interface BaseJobContextOptions {
  id: string;
  logger: ChronoLogger;
  signal: AbortSignal;
}
export declare class JobContext {
  readonly id: string;
  readonly log: ChronoLogger;
  readonly signal: AbortSignal;
  private _progress;
  constructor(opts: BaseJobContextOptions);
  progress(value: number): void;
  getProgress(): number;
}
//# sourceMappingURL=job-context.d.ts.map
