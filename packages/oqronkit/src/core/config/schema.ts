import { z } from "zod";
import type { IOqronAdapter } from "../types/db.types.js";
import type { ILockAdapter } from "../types/lock.types.js";

// Duck-typing validators for DI instances
const isIOqronAdapter = (val: unknown): val is IOqronAdapter => {
  if (!val || typeof val !== "object") return false;
  return (
    typeof (val as any).upsertSchedule === "function" &&
    typeof (val as any).getDueSchedules === "function"
  );
};

const isILockAdapter = (val: unknown): val is ILockAdapter => {
  if (!val || typeof val !== "object") return false;
  return (
    typeof (val as any).acquire === "function" &&
    typeof (val as any).renew === "function"
  );
};

export const OqronConfigSchema = z.object({
  project: z.string().optional(),
  environment: z.string().default("development"),

  // Infrastructure — Union of explicit DI or declarative config
  db: z
    .union([
      z.custom<IOqronAdapter>(
        isIOqronAdapter,
        "db must be an instance of IOqronAdapter",
      ),
      z.object({
        adapter: z.enum([
          "sqlite",
          "memory",
          "postgres",
          "mysql",
          "mongodb",
          "redis",
        ]),
        url: z.string().optional(),
        poolMin: z.number().default(2),
        poolMax: z.number().default(10),
        tablePrefix: z.string().default("chrono_"),
        migrations: z
          .union([z.enum(["auto", "manual"]), z.literal(false)])
          .default("auto"),
        ssl: z.boolean().default(false),
      }),
    ])
    .optional(),

  lock: z
    .union([
      z.custom<ILockAdapter>(
        isILockAdapter,
        "lock must be an instance of ILockAdapter",
      ),
      z.object({
        adapter: z.enum(["db", "memory", "redis"]),
        url: z.string().optional(),
        ttl: z.number().default(30000),
        retryDelay: z.number().default(200),
        retryCount: z.number().default(5),
      }),
    ])
    .optional(),

  broker: z.any().optional(),

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

  // Auto-discovery directory
  jobsDir: z.string().default("./src/jobs"),

  // Global tags
  tags: z.array(z.string()).default([]),

  // Worker
  worker: z
    .object({
      concurrency: z.number().default(50),
      gracefulShutdownMs: z.number().default(30000),
    })
    .default({ concurrency: 50, gracefulShutdownMs: 30000 }),

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
