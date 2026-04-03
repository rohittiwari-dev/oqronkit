import { z } from "zod";
import type {
  CronModuleDef,
  OqronModuleDef,
  QueueModuleDef,
  SchedulerModuleDef,
} from "../../modules.js";

// ── Resolved Module Config Defaults ─────────────────────────────────────────

const DEFAULT_CRON: Omit<Required<CronModuleDef>, "clustering"> & {
  clustering?: CronModuleDef["clustering"];
} = {
  module: "cron",
  timezone: "UTC",
  tickInterval: 1000,
  missedFirePolicy: "run-once",
  maxConcurrentJobs: 5,
  leaderElection: true,
  keepJobHistory: true,
  keepFailedJobHistory: true,
  shutdownTimeout: 25000,
  lagMonitor: { maxLagMs: 5000, sampleIntervalMs: 1000 },
};

const DEFAULT_SCHEDULER: Omit<Required<SchedulerModuleDef>, "clustering"> & {
  clustering?: SchedulerModuleDef["clustering"];
} = {
  module: "scheduler",
  tickInterval: 1000,
  timezone: "UTC",
  leaderElection: true,
  keepJobHistory: true,
  keepFailedJobHistory: true,
  shutdownTimeout: 25000,
  lagMonitor: { maxLagMs: 5000, sampleIntervalMs: 1000 },
};

const DEFAULT_QUEUE: Required<QueueModuleDef> = {
  module: "queue",
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
};

/**
 * Apply defaults to a normalized OqronModuleDef.
 * Deep-merges nested objects (lagMonitor, retries, deadLetter).
 */
export function applyModuleDefaults(def: OqronModuleDef): OqronModuleDef {
  switch (def.module) {
    case "cron":
      return applyCronDefaults(def);
    case "scheduler":
      return applySchedulerDefaults(def);
    case "queue":
      return applyQueueDefaults(def);
    default:
      return def;
  }
}

function applyCronDefaults(def: CronModuleDef): CronModuleDef {
  return {
    ...DEFAULT_CRON,
    ...def,
    module: "cron",
    lagMonitor: { ...DEFAULT_CRON.lagMonitor, ...(def.lagMonitor ?? {}) },
    clustering: def.clustering,
  };
}

function applySchedulerDefaults(def: SchedulerModuleDef): SchedulerModuleDef {
  return {
    ...DEFAULT_SCHEDULER,
    ...def,
    module: "scheduler",
    lagMonitor: { ...DEFAULT_SCHEDULER.lagMonitor, ...(def.lagMonitor ?? {}) },
    clustering: def.clustering,
  };
}

function applyQueueDefaults(def: QueueModuleDef): QueueModuleDef {
  return {
    ...DEFAULT_QUEUE,
    ...def,
    module: "queue",
    retries: { ...DEFAULT_QUEUE.retries, ...(def.retries ?? {}) },
    deadLetter: { ...DEFAULT_QUEUE.deadLetter, ...(def.deadLetter ?? {}) },
  };
}

// ── Main Config Schema ──────────────────────────────────────────────────────

export const OqronConfigSchema = z.object({
  project: z.string().optional(),
  environment: z.string().default("development"),

  // Storage mode
  mode: z.enum(["default", "db", "redis", "hybrid-db"]).default("default"),

  // Infrastructure
  redis: z.any().optional(),

  // PostgreSQL
  postgres: z
    .object({
      connectionString: z.string(),
      tablePrefix: z.string().default("oqron"),
      poolSize: z.number().default(10),
    })
    .optional(),

  // Modules — accepts any[] at the Zod layer; runtime normalizes before use
  modules: z.array(z.any()).default([]),

  // Trigger auto-discovery: string path, false to disable, or omit for auto-detect
  triggers: z.union([z.string(), z.literal(false)]).optional(),

  // Global tags
  tags: z.array(z.string()).default([]),

  // Logger
  logger: z
    .union([
      z.literal(false),
      z.object({
        enabled: z.boolean().default(true),
        level: z.string().default("info"),
        prettify: z.boolean().default(false),
        showMetadata: z.boolean().default(true),
        redact: z.array(z.string()).default([]),
      }),
    ])
    .default({
      enabled: true,
      level: "info",
      prettify: false,
      showMetadata: true,
      redact: [],
    }),

  // Telemetry
  telemetry: z
    .object({
      prometheus: z
        .object({
          enabled: z.boolean().default(false),
          path: z.string().default("/metrics"),
        })
        .default({}),
      opentelemetry: z
        .object({
          enabled: z.boolean().default(false),
        })
        .default({}),
    })
    .default({}),

  // Observability (alpha-5 port)
  observability: z
    .object({
      maxJobLogs: z.number().default(200),
      maxTimelineEntries: z.number().default(20),
      trackMemory: z.boolean().default(true),
      logCollector: z.boolean().default(true),
      logCollectorMaxGlobal: z.number().default(500),
      logCollectorMaxPerCategory: z.number().default(200),
    })
    .default({}),

  // UI Dashboard configuration
  ui: z
    .object({
      enabled: z.boolean().default(false),
      auth: z
        .object({
          username: z.string().optional(),
          password: z.string().optional(),
        })
        .optional(),
      retention: z
        .object({
          runs: z.string().default("30d"),
          events: z.string().default("7d"),
          metrics: z.string().default("30d"),
        })
        .default({}),
    })
    .default({}),

  // Shutdown
  shutdown: z
    .object({
      enabled: z.boolean().default(true),
      timeout: z.number().default(30000),
      signals: z.array(z.string()).default(["SIGINT", "SIGTERM"]),
    })
    .default({}),
});

export type ValidatedConfig = Omit<
  z.infer<typeof OqronConfigSchema>,
  "modules"
> & {
  /** Normalized and default-merged module definitions */
  modules: OqronModuleDef[];
};
