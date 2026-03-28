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
  lock: {
    adapter: "memory",
    ttl: 30000,
    retryDelay: 200,
    retryCount: 5,
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

  const isILockAdapter = (val: any) =>
    val && typeof val === "object" && typeof val.acquire === "function";

  return {
    project: config.project ?? defaultConfig.project,
    environment: config.environment ?? defaultConfig.environment,

    db: config.db
      ? isIOqronAdapter(config.db)
        ? (config.db as any)
        : { ...(defaultConfig.db as any), ...config.db }
      : defaultConfig.db,

    lock: config.lock
      ? isILockAdapter(config.lock)
        ? (config.lock as any)
        : { ...(defaultConfig.lock as any), ...config.lock }
      : defaultConfig.lock,

    broker: config.broker,

    modules: config.modules ?? defaultConfig.modules,

    cron: {
      ...defaultConfig.cron,
      ...config.cron,
    },

    scheduler: {
      ...defaultConfig.scheduler,
      ...config.scheduler,
    },

    jobsDir: config.jobsDir ?? defaultConfig.jobsDir,
    tags: config.tags ?? defaultConfig.tags,

    logger:
      config.logger === false
        ? false
        : {
            ...(defaultConfig.logger as any),
            ...config.logger,
          },

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
