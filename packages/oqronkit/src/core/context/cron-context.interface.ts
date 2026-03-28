import type { Logger } from "../logger/index.js";

// Interface the Cron handler receives — avoids circular type import
export interface ICronContext {
  readonly id: string;
  readonly log: Logger;
  readonly signal: AbortSignal;
  readonly firedAt: Date;
  readonly scheduleName: string;
  readonly duration: number;
  readonly environment?: string;
  readonly project?: string;
  progress(value: number, label?: string): void;
  getProgress(): number;
}
