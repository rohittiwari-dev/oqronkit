import { z } from "zod";
import type { IChronoAdapter } from "../types/db.types.js";
import type { ILockAdapter } from "../types/lock.types.js";

// Helper to validate a class instance that satisfies an interface
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

  // Infrastructure dependencies are REQUIRED to be provided by the consumer
  db: z.custom<IChronoAdapter>(
    isIChronoAdapter,
    "db must be an instance of IChronoAdapter",
  ),
  lock: z.custom<ILockAdapter>(
    isILockAdapter,
    "lock must be an instance of ILockAdapter",
  ),
  broker: z.any().optional(),

  // enabled modules Array
  modules: z.array(z.string()).default([]),

  // global tags
  tags: z.array(z.string()).default([]),

  // worker configs
  worker: z
    .object({
      concurrency: z.number().default(50),
      gracefulShutdownMs: z.number().default(30000),
    })
    .default({ concurrency: 50, gracefulShutdownMs: 30000 }),

  logger: z
    .object({
      level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    })
    .default({ level: "info" }),
});

export type ValidatedConfig = z.infer<typeof ChronoConfigSchema>;
