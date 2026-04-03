import { normalizeModules } from "../../modules.js";
import type { OqronConfig } from "../types/config.types.js";
import { applyModuleDefaults, type ValidatedConfig } from "./schema.js";

export function reconfigureConfig(config: OqronConfig): ValidatedConfig {
  // 1. Normalize the flexible module inputs into OqronModuleDef[]
  const rawModules = normalizeModules(config.modules ?? []);

  // 2. Apply defaults to each module definition
  const modules = rawModules.map(applyModuleDefaults);

  return {
    project: config.project ?? "oqronkit",
    environment: config.environment ?? "development",
    mode: config.mode ?? "default",

    redis: config.redis,

    modules,

    jobsDir: config.jobsDir ?? "./src/jobs",
    tags: config.tags ?? [],

    logger:
      config.logger === false
        ? false
        : {
            enabled: true,
            level: "info",
            prettify: false,
            showMetadata: true,
            redact: [],
            ...(typeof config.logger === "object" ? config.logger : {}),
          },

    telemetry: {
      prometheus: {
        enabled: false,
        path: "/metrics",
        ...config.telemetry?.prometheus,
      },
      opentelemetry: {
        enabled: false,
        ...config.telemetry?.opentelemetry,
      },
    },

    observability: {
      maxJobLogs: 200,
      maxTimelineEntries: 20,
      trackMemory: true,
      logCollector: true,
      logCollectorMaxGlobal: 500,
      logCollectorMaxPerCategory: 200,
      ...config.observability,
    },

    ui: {
      enabled: false,
      ...config.ui,
      auth: config.ui?.auth,
      retention: {
        runs: "30d",
        events: "7d",
        metrics: "30d",
        ...config.ui?.retention,
      },
    },

    shutdown: {
      enabled: true,
      timeout: 30000,
      signals: ["SIGINT", "SIGTERM"],
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
