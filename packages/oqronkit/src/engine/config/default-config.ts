import { normalizeModules } from "../../modules.js";
import type { OqronConfig } from "../types/config.types.js";
import {
  applyModuleDefaults,
  OqronConfigSchema,
  type ValidatedConfig,
} from "./schema.js";

export function reconfigureConfig(config: OqronConfig): ValidatedConfig {
  const parsed = OqronConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(
      `[OqronKit] Invalid config: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  const validated = parsed.data as OqronConfig;

  // 1. Normalize the flexible module inputs into OqronModuleDef[]
  const rawModules = normalizeModules(validated.modules ?? []);

  // 2. Apply defaults to each module definition
  const modules = rawModules.map(applyModuleDefaults);

  return {
    project: validated.project ?? "oqronkit",
    environment: validated.environment ?? "development",
    mode: validated.mode ?? "default",

    redis: validated.redis,
    adapters: config.adapters,

    modules,

    triggers: validated.triggers,
    tags: validated.tags ?? [],

    logger:
      validated.logger === false
        ? false
        : {
            enabled: true,
            level: "info",
            prettify: false,
            showMetadata: true,
            redact: [],
            ...(typeof validated.logger === "object" ? validated.logger : {}),
          },

    telemetry: {
      prometheus: {
        enabled: false,
        path: "/metrics",
        ...validated.telemetry?.prometheus,
      },
      opentelemetry: {
        enabled: false,
        ...validated.telemetry?.opentelemetry,
      },
    },

    observability: {
      maxJobLogs: 200,
      maxTimelineEntries: 20,
      trackMemory: true,
      logCollector: true,
      logCollectorMaxGlobal: 500,
      logCollectorMaxPerCategory: 200,
      ...validated.observability,
    },

    ui: {
      enabled: false,
      ...validated.ui,
      auth: validated.ui?.auth,
      retention: {
        runs: "30d",
        events: "7d",
        metrics: "30d",
        ...validated.ui?.retention,
      },
    },

    shutdown: {
      enabled: true,
      timeout: 30000,
      signals: ["SIGINT", "SIGTERM"],
      ...validated.shutdown,
    },

    postgres: validated.postgres
      ? {
          connectionString: validated.postgres.connectionString,
          tablePrefix: validated.postgres.tablePrefix ?? "oqron",
          poolSize: validated.postgres.poolSize ?? 10,
        }
      : undefined,
  };
}
