import type { OqronConfig } from "../types";
import type { ValidatedConfig } from "./schema";

const defaultConfig: ValidatedConfig = {
  project: "oqronkit",
  environment: "development",
  db: {
    adapter: "memory",
    poolMin: 2,
    poolMax: 10,
    tablePrefix: "oqron_",
    migrations: "auto",
    ssl: false,
  },
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
  },
  scheduler: {
    enable: true,
    tickInterval: 1000,
    keepJobHistory: true,
    keepFailedJobHistory: true,
  },
  taskQueue: {
    concurrency: 5,
    heartbeatMs: 5000,
    lockTtlMs: 30000,
    retries: {
      max: 3,
      strategy: "exponential",
      baseDelay: 2000,
      maxDelay: 60000,
    },
    deadLetter: { enabled: true },
  },
  queue: {
    defaultTtl: 86400000,
    ack: "leader",
  },
  worker: {
    concurrency: 5,
    heartbeatMs: 5000,
    lockTtlMs: 30000,
    retries: {
      max: 3,
      strategy: "exponential",
      baseDelay: 2000,
      maxDelay: 60000,
    },
    deadLetter: { enabled: true },
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
    prometheus: {
      enabled: false,
      path: "/metrics",
    },
    opentelemetry: {
      enabled: false,
    },
  },
  shutdown: {
    enabled: true,
    timeout: 30000,
    signals: ["SIGINT", "SIGTERM"],
  },
};

export function reconfigureConfig(config: OqronConfig): ValidatedConfig {
  const isIOqronAdapter = (val: any) =>
    val && typeof val === "object" && typeof val.upsertSchedule === "function";

  return {
    project: config.project ?? defaultConfig.project,
    environment: config.environment ?? defaultConfig.environment,

    db: config.db
      ? isIOqronAdapter(config.db)
        ? (config.db as any)
        : { ...(defaultConfig.db as any), ...config.db }
      : defaultConfig.db,

    redis: config.redis,

    modules: config.modules ?? defaultConfig.modules,

    cron: {
      ...defaultConfig.cron,
      ...config.cron,
    },

    scheduler: {
      ...defaultConfig.scheduler,
      ...config.scheduler,
    },

    taskQueue: {
      ...defaultConfig.taskQueue,
      ...config.taskQueue,
      retries: {
        ...defaultConfig.taskQueue.retries,
        ...config.taskQueue?.retries,
      },
      deadLetter: {
        ...defaultConfig.taskQueue.deadLetter,
        ...config.taskQueue?.deadLetter,
      },
    },

    queue: {
      ...defaultConfig.queue,
      ...config.queue,
    },

    worker: {
      ...defaultConfig.worker,
      ...config.worker,
      retries: {
        ...defaultConfig.worker.retries,
        ...config.worker?.retries,
      },
      deadLetter: {
        ...defaultConfig.worker.deadLetter,
        ...config.worker?.deadLetter,
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

    shutdown: {
      ...defaultConfig.shutdown,
      ...config.shutdown,
    },
  };
}
