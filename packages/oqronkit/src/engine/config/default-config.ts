import type { OqronConfig } from "../types/config.types.js";
import type { ValidatedConfig } from "./schema.js";

const defaultConfig: ValidatedConfig = {
  project: "oqronkit",
  environment: "development",
  mode: "default",
  modules: [],

  cron: {
    enable: true,
    timezone: "UTC",
    tickInterval: 1000,
    missedFirePolicy: "run-once",
    maxConcurrentJobs: 5,
    leaderElection: true,
    keepJobHistory: true,
    keepFailedJobHistory: true,
    shutdownTimeout: 25000,
    lagMonitor: { maxLagMs: 5000, sampleIntervalMs: 1000 },
  },

  scheduler: {
    enable: true,
    tickInterval: 1000,
    timezone: "UTC",
    leaderElection: true,
    keepJobHistory: true,
    keepFailedJobHistory: true,
    shutdownTimeout: 25000,
    lagMonitor: { maxLagMs: 5000, sampleIntervalMs: 1000 },
  },

  queue: {
    concurrency: 5,
    heartbeatMs: 5000,
    lockTtlMs: 30000,
    strategy: "fifo",
    retries: {
      max: 3,
      strategy: "exponential",
      baseDelay: 2000,
      maxDelay: 60000,
    },
    deadLetter: { enabled: true },
    removeOnComplete: false,
    removeOnFail: false,
    shutdownTimeout: 25000,
    maxStalledCount: 1,
    stalledInterval: 30000,
  },

  jobsDir: "./src/jobs",
  tags: [],

  logger: {
    enabled: true,
    level: "info",
    prettify: false,
    showMetadata: true,
    redact: [],
  },

  telemetry: {
    prometheus: { enabled: false, path: "/metrics" },
    opentelemetry: { enabled: false },
  },

  observability: {
    maxJobLogs: 200,
    maxTimelineEntries: 20,
    trackMemory: true,
    logCollector: true,
    logCollectorMaxGlobal: 500,
    logCollectorMaxPerCategory: 200,
  },

  ui: {
    enabled: false,
    retention: { runs: "30d", events: "7d", metrics: "30d" },
  },

  shutdown: {
    enabled: true,
    timeout: 30000,
    signals: ["SIGINT", "SIGTERM"],
  },
};

export function reconfigureConfig(config: OqronConfig): ValidatedConfig {
  return {
    project: config.project ?? defaultConfig.project,
    environment: config.environment ?? defaultConfig.environment,
    mode: config.mode ?? defaultConfig.mode,

    redis: config.redis,

    modules: config.modules ?? defaultConfig.modules,

    cron: {
      ...defaultConfig.cron,
      ...config.cron,
      lagMonitor: {
        ...defaultConfig.cron.lagMonitor,
        ...config.cron?.lagMonitor,
      },
      clustering: config.cron?.clustering,
    },

    scheduler: {
      ...defaultConfig.scheduler,
      ...config.scheduler,
      lagMonitor: {
        ...defaultConfig.scheduler.lagMonitor,
        ...config.scheduler?.lagMonitor,
      },
      clustering: config.scheduler?.clustering,
    },

    queue: {
      ...defaultConfig.queue,
      ...config.queue,
      retries: {
        ...defaultConfig.queue.retries,
        ...config.queue?.retries,
      },
      deadLetter: {
        ...defaultConfig.queue.deadLetter,
        ...config.queue?.deadLetter,
      },
    },

    jobsDir: config.jobsDir ?? defaultConfig.jobsDir,
    tags: config.tags ?? defaultConfig.tags,

    logger:
      config.logger === false
        ? false
        : ({
            ...(defaultConfig.logger as Extract<
              ValidatedConfig["logger"],
              object
            >),
            ...(config.logger as Extract<ValidatedConfig["logger"], object>),
          } as ValidatedConfig["logger"]),

    telemetry: {
      prometheus: {
        ...defaultConfig.telemetry.prometheus,
        ...config.telemetry?.prometheus,
      },
      opentelemetry: {
        ...defaultConfig.telemetry.opentelemetry,
        ...config.telemetry?.opentelemetry,
      },
    },

    observability: {
      ...defaultConfig.observability,
      ...config.observability,
    },

    ui: {
      ...defaultConfig.ui,
      ...config.ui,
      auth: config.ui?.auth,
      retention: {
        ...defaultConfig.ui.retention,
        ...config.ui?.retention,
      },
    },

    shutdown: {
      ...defaultConfig.shutdown,
      ...config.shutdown,
    },

    postgres: config.postgres
      ? {
          connectionString: config.postgres.connectionString,
          tablePrefix: config.postgres.tablePrefix ?? "oqron",
          poolSize: config.postgres.poolSize ?? 10,
        }
      : undefined,
  };
}
