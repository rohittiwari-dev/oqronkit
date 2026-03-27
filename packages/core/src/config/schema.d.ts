import { z } from "zod";
export declare const ChronoConfigSchema: z.ZodObject<
  {
    environment: z.ZodDefault<z.ZodString>;
    db: z.ZodDefault<
      z.ZodObject<
        {
          type: z.ZodDefault<z.ZodEnum<["sqlite", "postgres"]>>;
          url: z.ZodOptional<z.ZodString>;
        },
        "strip",
        z.ZodTypeAny,
        {
          type: "sqlite" | "postgres";
          url?: string | undefined;
        },
        {
          type?: "sqlite" | "postgres" | undefined;
          url?: string | undefined;
        }
      >
    >;
    lock: z.ZodDefault<
      z.ZodObject<
        {
          type: z.ZodDefault<z.ZodEnum<["db", "redis"]>>;
        },
        "strip",
        z.ZodTypeAny,
        {
          type: "db" | "redis";
        },
        {
          type?: "db" | "redis" | undefined;
        }
      >
    >;
    logger: z.ZodDefault<
      z.ZodObject<
        {
          level: z.ZodDefault<z.ZodEnum<["debug", "info", "warn", "error"]>>;
        },
        "strip",
        z.ZodTypeAny,
        {
          level: "debug" | "info" | "warn" | "error";
        },
        {
          level?: "debug" | "info" | "warn" | "error" | undefined;
        }
      >
    >;
  },
  "strip",
  z.ZodTypeAny,
  {
    db: {
      type: "sqlite" | "postgres";
      url?: string | undefined;
    };
    environment: string;
    lock: {
      type: "db" | "redis";
    };
    logger: {
      level: "debug" | "info" | "warn" | "error";
    };
  },
  {
    db?:
      | {
          type?: "sqlite" | "postgres" | undefined;
          url?: string | undefined;
        }
      | undefined;
    environment?: string | undefined;
    lock?:
      | {
          type?: "db" | "redis" | undefined;
        }
      | undefined;
    logger?:
      | {
          level?: "debug" | "info" | "warn" | "error" | undefined;
        }
      | undefined;
  }
>;
export type ValidatedConfig = z.infer<typeof ChronoConfigSchema>;
//# sourceMappingURL=schema.d.ts.map
