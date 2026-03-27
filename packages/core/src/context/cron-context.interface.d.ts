import type { ChronoLogger } from "../logger/voltlog.js";
export interface ICronContext {
  readonly id: string;
  readonly log: ChronoLogger;
  readonly signal: AbortSignal;
  readonly firedAt: Date;
  readonly scheduleName: string;
  progress(value: number): void;
  getProgress(): number;
}
//# sourceMappingURL=cron-context.interface.d.ts.map
