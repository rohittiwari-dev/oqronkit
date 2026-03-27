import { z } from "zod";

export const ChronoConfigSchema = z.object({
  environment: z.string().default("development"),
  db: z
    .object({
      type: z.enum(["sqlite", "postgres"]).default("sqlite"),
      url: z.string().optional(),
    })
    .default({ type: "sqlite" }),
  lock: z
    .object({
      type: z.enum(["db", "redis"]).default("db"),
    })
    .default({ type: "db" }),
  logger: z
    .object({
      level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    })
    .default({ level: "info" }),
});

export type ValidatedConfig = z.infer<typeof ChronoConfigSchema>;
