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

// ── Main Config Schema ──────────────────────────────────────────────────────

export const OqronConfigSchema = z.object({
  project: z.string().optional(),
  environment: z.string().default("development"),

  // Infrastructure
  redis: z.any().optional(),

  // Modules
  modules: z
    .array(
      z.enum([
        "cron",
        "scheduler",
        "taskQueue",
        "queue",
        "worker",
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
    })
    .default({}),

  // ── TaskQueue ────────────────────────────────────────────────────────────
  taskQueue: z
    .object({
      concurrency: z.number().default(5),
      heartbeatMs: z.number().default(5000),
      lockTtlMs: z.number().default(30000),
      retries: RetriesSchema,
      deadLetter: DeadLetterSchema,
      removeOnComplete: RemoveOnConfigSchema.default(false),
      removeOnFail: RemoveOnConfigSchema.default(false),
      shutdownTimeout: z.number().default(25000),
      maxStalledCount: z.number().default(1),
      stalledInterval: z.number().default(30000),
    })
    .default({}),

  // ── Queue ────────────────────────────────────────────────────────────────
  queue: z
    .object({
      defaultTtl: z.number().default(86400 * 1000),
      ack: z.enum(["leader", "all", "none"]).default("leader"),
    })
    .default({}),

  // ── Worker ───────────────────────────────────────────────────────────────
  worker: z
    .object({
      concurrency: z.number().default(5),
      heartbeatMs: z.number().default(5000),
      lockTtlMs: z.number().default(30000),
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
