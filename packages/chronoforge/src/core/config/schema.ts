import { z } from "zod";
import type { IChronoAdapter } from "../types/db.types.js";
import type { ILockAdapter } from "../types/lock.types.js";

// Duck-typing validators for DI instances
const isIChronoAdapter = (val: unknown): val is IChronoAdapter => {
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

export const ChronoConfigSchema = z.object({
  project: z.string().optional(),
  environment: z.string().default("development"),

  // Infrastructure — explicit DI
  db: z.custom<IChronoAdapter>(
    isIChronoAdapter,
    "db must be an instance of IChronoAdapter",
  ),
  lock: z.custom<ILockAdapter>(
    isILockAdapter,
    "lock must be an instance of ILockAdapter",
  ),
  broker: z.any().optional(),

  // Modules
  modules: z.array(z.string()).default([]),

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
      }),
    ])
    .default({
      enabled: true,
      level: "info",
      prettify: false,
      showMetadata: true,
    }),
});

export type ValidatedConfig = z.infer<typeof ChronoConfigSchema>;
