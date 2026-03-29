import { z } from "zod";
// Duck-typing validators removed in favor of plain generic config (DatabaseLike / RedisLike)

export const OqronConfigSchema = z.object({
  project: z.string().optional(),
  environment: z.string().default("development"),

  // Infrastructure — Unified connection inputs
  redis: z.any().optional(), // RedisLike (accepts ioredis instances or config objects)

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

  // Module-specific configs
  cron: z
    .object({
      enable: z.boolean().default(true),
      timezone: z.string().optional(),
      tickInterval: z.number().default(1000),
      missedFirePolicy: z
        .enum(["skip", "run-once", "run-all"])
        .default("run-once"),
      maxConcurrentJobs: z.number().default(5),
      leaderElection: z.boolean().default(true),
      keepJobHistory: z.union([z.boolean(), z.number()]).default(true),
      keepFailedJobHistory: z.union([z.boolean(), z.number()]).default(true),
    })
    .default({}),

  scheduler: z
    .object({
      enable: z.boolean().default(true),
      tickInterval: z.number().default(1000),
      keepJobHistory: z.union([z.boolean(), z.number()]).default(true),
      keepFailedJobHistory: z.union([z.boolean(), z.number()]).default(true),
    })
    .default({}),

  taskQueue: z
    .object({
      concurrency: z.number().default(5),
      heartbeatMs: z.number().default(5000),
      lockTtlMs: z.number().default(30000),
      retries: z
        .object({
          max: z.number().default(3),
          strategy: z.enum(["fixed", "exponential"]).default("exponential"),
          baseDelay: z.number().default(2000),
          maxDelay: z.number().default(60000),
        })
        .default({}),
      deadLetter: z
        .object({
          enabled: z.boolean().default(true),
        })
        .default({}),
    })
    .default({}),

  queue: z
    .object({
      defaultTtl: z.number().default(86400 * 1000), // 24 hours
      ack: z.enum(["leader", "all", "none"]).default("leader"),
    })
    .default({}),

  worker: z
    .object({
      concurrency: z.number().default(5),
      heartbeatMs: z.number().default(5000),
      lockTtlMs: z.number().default(30000),
      retries: z
        .object({
          max: z.number().default(3),
          strategy: z.enum(["fixed", "exponential"]).default("exponential"),
          baseDelay: z.number().default(2000),
          maxDelay: z.number().default(60000),
        })
        .default({}),
      deadLetter: z
        .object({
          enabled: z.boolean().default(true),
        })
        .default({}),
    })
    .default({}),

  // Auto-discovery directory
  jobsDir: z.string().default("./src/jobs"),

  // Global tags
  tags: z.array(z.string()).default([]),

  // Logger (voltlog-io config or false to disable)
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
