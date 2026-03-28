import type { Logger } from "../logger/index.js";
import type { IScheduleContext } from "../types/index.js";

export interface ScheduleContextOptions<TPayload> {
  id: string;
  scheduleName: string;
  firedAt: Date;
  payload: TPayload;
  logger: Logger;
  signal: AbortSignal;
  onProgress?: (percent: number, label?: string) => void;
}

export class ScheduleContext<TPayload = unknown>
  implements IScheduleContext<TPayload>
{
  public readonly id: string;
  public readonly name: string;
  public readonly firedAt: Date;
  public readonly payload: TPayload;
  private readonly logger: Logger;
  private readonly signal: AbortSignal;
  private readonly startedLocalAt: number;
  private readonly _onProgress?: (percent: number, label?: string) => void;

  constructor(opts: ScheduleContextOptions<TPayload>) {
    this.id = opts.id;
    this.name = opts.scheduleName;
    this.firedAt = opts.firedAt;
    this.payload = opts.payload;
    this.logger = opts.logger;
    this.signal = opts.signal;
    this.startedLocalAt = Date.now();
    this._onProgress = opts.onProgress;

    // Bind methods so they can be destructured safely
    this.log = this.log.bind(this);
    this.progress = this.progress.bind(this);
  }

  get aborted(): boolean {
    return this.signal.aborted;
  }

  get duration(): number {
    return Date.now() - this.startedLocalAt;
  }

  log(level: string, message: string, meta?: Record<string, unknown>): void {
    if (this.logger && typeof (this.logger as any)[level] === "function") {
      (this.logger as any)[level](message, meta);
    }
  }

  progress(percent: number, label?: string): void {
    if (this._onProgress) {
      this._onProgress(percent, label);
    } else {
      this.logger.debug("Progress updated", { percent, label, runId: this.id });
    }
  }
}
