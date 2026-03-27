import type { ChronoLogger } from "../logger/voltlog.js";

export interface BaseJobContextOptions {
  id: string;
  logger: ChronoLogger;
  signal: AbortSignal;
}

export class JobContext {
  public readonly id: string;
  public readonly log: ChronoLogger;
  public readonly signal: AbortSignal;
  private _progress = 0;

  constructor(opts: BaseJobContextOptions) {
    this.id = opts.id;
    this.log = opts.logger;
    this.signal = opts.signal;
  }

  progress(value: number): void {
    this._progress = Math.max(0, Math.min(100, value));
  }

  getProgress(): number {
    return this._progress;
  }
}
