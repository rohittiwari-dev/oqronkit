import type { Logger } from "../logger/index.js";

export interface BaseJobContextOptions {
  id: string;
  logger: Logger;
  signal: AbortSignal;
  environment?: string;
  project?: string;
  onProgress?: (percent: number, label?: string) => void;
}

export class JobContext {
  public readonly id: string;
  public readonly log: Logger;
  public readonly signal: AbortSignal;
  public readonly environment?: string;
  public readonly project?: string;
  private _progress = 0;
  private _onProgress?: (percent: number, label?: string) => void;

  constructor(opts: BaseJobContextOptions) {
    this.id = opts.id;
    this.log = opts.logger;
    this.signal = opts.signal;
    this.environment = opts.environment;
    this.project = opts.project;
    this._onProgress = opts.onProgress;

    // Bind methods
    this.progress = this.progress.bind(this);
  }

  progress(value: number, label?: string): void {
    this._progress = Math.max(0, Math.min(100, value));
    if (this._onProgress) {
      this._onProgress(this._progress, label);
    }
  }

  getProgress(): number {
    return this._progress;
  }
}
