/**
 * ChronoForge Logger — powered by voltlog-io.
 *
 * Re-exports a configured voltlog-io logger instance.
 * Users can customize via cnforge.config.ts `logger` section.
 */
import {
  consoleTransport,
  createLogger as createVoltLogger,
  type Logger,
  type LogLevelName,
  prettyTransport,
  type LoggerOptions as VoltLoggerOptions,
} from "voltlog-io";

export type { Logger, LogLevelName };

export interface ChronoLoggerConfig {
  /** Enable/disable logging entirely. Default: true */
  enabled?: boolean;
  /** Minimum log level. Default: 'INFO' */
  level?: string;
  /** Pretty-print with colors/icons for dev. Default: false */
  prettify?: boolean;
  /** Show metadata object in logs. Default: true */
  showMetadata?: boolean;
  /** Custom voltlog-io transport handler */
  handler?: (entry: any) => void | Promise<void>;
  /** Bring-your-own logger instance (Pino, winston, etc) */
  logger?: any;
}

/** NOOP logger that satisfies the Logger interface but does nothing */
const NOOP_LOGGER: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return NOOP_LOGGER;
  },
  addTransport() {},
  removeTransport() {},
  addMiddleware() {},
  removeMiddleware() {},
  setLevel() {},
  getLevel() {
    return "SILENT" as LogLevelName;
  },
  isLevelEnabled() {
    return false;
  },
  startTimer() {
    return { done() {}, elapsed: () => 0 };
  },
  async flush() {},
  async close() {},
};

/**
 * Create a ChronoForge logger from config.
 * This is the single factory used internally.
 */
export function createLogger(
  config?: ChronoLoggerConfig,
  context?: Record<string, unknown>,
): Logger {
  if (config?.enabled === false) return NOOP_LOGGER;

  // If user provides their own logger, use it directly
  if (config?.logger) return config.logger;

  const level = (config?.level ?? "INFO").toUpperCase() as LogLevelName;

  const opts: VoltLoggerOptions = {
    level,
    transports: [],
    context,
  };

  if (config?.prettify) {
    opts.transports!.push(prettyTransport());
  } else {
    opts.transports!.push(consoleTransport());
  }

  return createVoltLogger(opts);
}
