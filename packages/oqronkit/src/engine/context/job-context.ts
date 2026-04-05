import type { Logger } from "../logger/index.js";

export interface BaseJobContextOptions {
  id: string;
  logger: Logger;
  signal: AbortSignal;
  environment?: string;
  project?: string;
  onProgress?: (percent: number, label?: string) => void;
  onLog?: (level: string, message: string) => void;
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
    this._onProgress = opts.onProgress;
    this.signal = opts.signal;
    this.environment = opts.environment;
    this.project = opts.project;

    // Wrap logger to intercept logs
    const originalLogger = opts.logger;
    const interceptor = (level: string) => (message: string, meta?: any) => {
      (originalLogger as any)[level](message, meta);
      if (opts.onLog) {
        opts.onLog(level, message);
      }
    };

    if (opts.onLog) {
      this.log = {
        ...originalLogger,
        debug: interceptor("debug"),
        info: interceptor("info"),
        warn: interceptor("warn"),
        error: interceptor("error"),
        child: originalLogger.child.bind(originalLogger), // we don't intercept children for now
      } as unknown as Logger;
    } else {
      this.log = originalLogger;
    }

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
