import type { ChronoLogger } from "../logger/voltlog.js";

// Interface the Cron handler receives — avoids circular type import
export interface ICronContext {
  readonly id: string;
  readonly log: ChronoLogger;
  readonly signal: AbortSignal;
  readonly firedAt: Date;
  readonly scheduleName: string;
  progress(value: number): void;
  getProgress(): number;
}
