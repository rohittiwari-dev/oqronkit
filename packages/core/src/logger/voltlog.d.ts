export type LogLevel = "debug" | "info" | "warn" | "error";
export interface LoggerOptions {
  level: LogLevel;
  module?: string;
}
export declare class ChronoLogger {
  private readonly threshold;
  private readonly moduleName;
  constructor(opts: LoggerOptions);
  private emit;
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(subModule: string): ChronoLogger;
}
export declare function createLogger(opts: LoggerOptions): ChronoLogger;
//# sourceMappingURL=voltlog.d.ts.map
