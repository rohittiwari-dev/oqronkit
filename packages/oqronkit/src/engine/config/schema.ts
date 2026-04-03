import { z } from "zod";

// ── Shared sub-schemas ──────────────────────────────────────────────────────

const KeepJobsSchema = z.object({
  age: z.number().optional(),
  count: z.number().optional(),
});

const RemoveOnConfigSchema = z.union([z.boolean(), z.number(), KeepJobsSchema]);

const RetriesSchema = z
  .object({
    max: z.number().default(3),
    strategy: z.enum(["fixed", "exponential"]).default("exponential"),
    baseDelay: z.number().default(2000),
    maxDelay: z.number().default(60000),
  })
  .default({});

const DeadLetterSchema = z
  .object({
    enabled: z.boolean().default(true),
  })
  .default({});

const LagMonitorSchema = z
  .object({
    maxLagMs: z.number().default(5000),
    sampleIntervalMs: z.number().default(1000),
  })
  .default({ maxLagMs: 5000, sampleIntervalMs: 1000 });

const ClusteringSchema = z
  .object({
    totalShards: z.number().optional(),
    ownedShards: z.array(z.number()).optional(),
    region: z.string().optional(),
  })
  .optional();

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

  // Modules
  modules: z
    .array(
      z.enum([
        "cron",
        "scheduler",
        "queue",
        "workflow",
        "batch",
        "webhook",
        "pipeline",
      ]),
    )
    .default([]),

  // ── Cron ─────────────────────────────────────────────────────────────────
  cron: z
    .object({
      enable: z.boolean().default(true),
      timezone: z.string().default("UTC"),
      tickInterval: z.number().default(1000),
      missedFirePolicy: z
        .enum(["skip", "run-once", "run-all"])
        .default("run-once"),
      maxConcurrentJobs: z.number().default(5),
      leaderElection: z.boolean().default(true),
      keepJobHistory: z.union([z.boolean(), z.number()]).default(true),
      keepFailedJobHistory: z.union([z.boolean(), z.number()]).default(true),
      shutdownTimeout: z.number().default(25000),
      lagMonitor: LagMonitorSchema,
      clustering: ClusteringSchema,
    })
    .default({}),

  // ── Scheduler ────────────────────────────────────────────────────────────
  scheduler: z
    .object({
      enable: z.boolean().default(true),
      tickInterval: z.number().default(1000),
      timezone: z.string().default("UTC"),
      leaderElection: z.boolean().default(true),
      keepJobHistory: z.union([z.boolean(), z.number()]).default(true),
      keepFailedJobHistory: z.union([z.boolean(), z.number()]).default(true),
      shutdownTimeout: z.number().default(25000),
      lagMonitor: LagMonitorSchema,
      clustering: ClusteringSchema,
    })
    .default({}),

  // ── Queue (renamed from TaskQueue) ────────────────────────────────────
  queue: z
    .object({
      concurrency: z.number().default(5),
      heartbeatMs: z.number().default(5000),
      lockTtlMs: z.number().default(30000),
      strategy: z.enum(["fifo", "lifo", "priority"]).default("fifo"),
      retries: RetriesSchema,
      deadLetter: DeadLetterSchema,
      removeOnComplete: RemoveOnConfigSchema.default(false),
      removeOnFail: RemoveOnConfigSchema.default(false),
      shutdownTimeout: z.number().default(25000),
      maxStalledCount: z.number().default(1),
      stalledInterval: z.number().default(30000),
    })
    .default({}),

  // Auto-discovery directory
  jobsDir: z.string().default("./src/jobs"),

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

export type ValidatedConfig = z.infer<typeof OqronConfigSchema>;
