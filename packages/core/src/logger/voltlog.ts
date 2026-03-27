export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggerOptions {
  level: LogLevel;
  module?: string;
}

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class ChronoLogger {
  private readonly threshold: number;
  private readonly moduleName: string;

  constructor(opts: LoggerOptions) {
    this.threshold = LEVELS[opts.level] ?? LEVELS.info;
    this.moduleName = opts.module ?? "chrono";
  }

  private emit(
    level: LogLevel,
    msg: string,
    meta?: Record<string, unknown>,
  ): void {
    if (LEVELS[level] < this.threshold) return;
    const entry = JSON.stringify({
      time: new Date().toISOString(),
      level,
      module: this.moduleName,
      msg,
      ...meta,
    });
    if (level === "error") console.error(entry);
    else if (level === "warn") console.warn(entry);
    else console.log(entry);
  }

  debug(msg: string, meta?: Record<string, unknown>): void {
    this.emit("debug", msg, meta);
  }
  info(msg: string, meta?: Record<string, unknown>): void {
    this.emit("info", msg, meta);
  }
  warn(msg: string, meta?: Record<string, unknown>): void {
    this.emit("warn", msg, meta);
  }
  error(msg: string, meta?: Record<string, unknown>): void {
    this.emit("error", msg, meta);
  }

  child(subModule: string): ChronoLogger {
    const parentLevel =
      (Object.keys(LEVELS) as LogLevel[]).find(
        (k) => LEVELS[k] === this.threshold,
      ) ?? "info";
    return new ChronoLogger({
      level: parentLevel,
      module: `${this.moduleName}:${subModule}`,
    });
  }
}

export function createLogger(opts: LoggerOptions): ChronoLogger {
  return new ChronoLogger(opts);
}
