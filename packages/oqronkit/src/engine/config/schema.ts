import { z } from "zod";
import type {
  BatchModuleDef,
  CronModuleDef,
  OqronModuleDef,
  QueueModuleDef,
  RateLimitModuleDef,
  SchedulerModuleDef,
  WebhookModuleDef,
  WorkerModuleDef,
} from "../../modules.js";

const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().nonnegative();
const postgresIdentifier = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Must be a safe PostgreSQL identifier");

// ── Resolved Module Config Defaults ─────────────────────────────────────────

const DEFAULT_CRON: Omit<
  Required<CronModuleDef>,
  "clustering" | "disabledBehavior" | "maxHeldJobs"
> & {
  clustering?: CronModuleDef["clustering"];
  disabledBehavior?: CronModuleDef["disabledBehavior"];
  maxHeldJobs?: CronModuleDef["maxHeldJobs"];
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

const DEFAULT_SCHEDULER: Omit<
  Required<SchedulerModuleDef>,
  "clustering" | "disabledBehavior" | "maxHeldJobs"
> & {
  clustering?: SchedulerModuleDef["clustering"];
  disabledBehavior?: SchedulerModuleDef["disabledBehavior"];
  maxHeldJobs?: SchedulerModuleDef["maxHeldJobs"];
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

const DEFAULT_QUEUE: Omit<
  Required<QueueModuleDef>,
  | "disabledBehavior"
  | "maxHeldJobs"
  | "lagMonitor"
  | "crossNodeStallScanner"
  | "reconciliation"
> & {
  disabledBehavior?: QueueModuleDef["disabledBehavior"];
  maxHeldJobs?: QueueModuleDef["maxHeldJobs"];
  lagMonitor?: QueueModuleDef["lagMonitor"];
  crossNodeStallScanner?: QueueModuleDef["crossNodeStallScanner"];
  reconciliation?: QueueModuleDef["reconciliation"];
} = {
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

const DEFAULT_WORKER: Omit<
  Required<WorkerModuleDef>,
  | "disabledBehavior"
  | "maxHeldJobs"
  | "lagMonitor"
  | "crossNodeStallScanner"
  | "reconciliation"
> & {
  disabledBehavior?: WorkerModuleDef["disabledBehavior"];
  maxHeldJobs?: WorkerModuleDef["maxHeldJobs"];
  lagMonitor?: WorkerModuleDef["lagMonitor"];
  crossNodeStallScanner?: WorkerModuleDef["crossNodeStallScanner"];
  reconciliation?: WorkerModuleDef["reconciliation"];
} = {
  module: "worker",
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

const DEFAULT_WEBHOOK: Omit<
  Required<WebhookModuleDef>,
  | "disabledBehavior"
  | "maxHeldJobs"
  | "removeOnComplete"
  | "removeOnFail"
  | "lagMonitor"
  | "crossNodeStallScanner"
  | "reconciliation"
  | "trackProgress"
> & {
  disabledBehavior?: WebhookModuleDef["disabledBehavior"];
  maxHeldJobs?: WebhookModuleDef["maxHeldJobs"];
  removeOnComplete?: WebhookModuleDef["removeOnComplete"];
  removeOnFail?: WebhookModuleDef["removeOnFail"];
  lagMonitor?: WebhookModuleDef["lagMonitor"];
  crossNodeStallScanner?: WebhookModuleDef["crossNodeStallScanner"];
  reconciliation?: WebhookModuleDef["reconciliation"];
  trackProgress?: WebhookModuleDef["trackProgress"];
} = {
  module: "webhook",
  concurrency: 5,
  heartbeatMs: 5000,
  lockTtlMs: 30000,
  retries: {
    max: 3,
    strategy: "exponential",
    baseDelay: 2000,
    maxDelay: 60000,
  },
  maxStalledCount: 1,
  shutdownTimeout: 25000,
  stalledInterval: 30000,
  timeout: 30000,
  strategy: "fifo",
  deadLetter: { enabled: true },
  removeOnComplete: false,
  removeOnFail: false,
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
    case "worker":
      return applyWorkerDefaults(def as WorkerModuleDef);
    case "webhook":
      return applyWebhookDefaults(def as WebhookModuleDef);
    case "ratelimit":
      return applyRateLimitDefaults(def as RateLimitModuleDef);
    case "batch":
      return applyBatchDefaults(def as BatchModuleDef);
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
    lagMonitor: {
      ...DEFAULT_SCHEDULER.lagMonitor,
      ...(def.lagMonitor ?? {}),
    },
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

function applyWorkerDefaults(def: WorkerModuleDef): WorkerModuleDef {
  return {
    ...DEFAULT_WORKER,
    ...def,
    module: "worker",
    retries: { ...DEFAULT_WORKER.retries, ...(def.retries ?? {}) },
    deadLetter: { ...DEFAULT_WORKER.deadLetter, ...(def.deadLetter ?? {}) },
  };
}

function applyWebhookDefaults(def: WebhookModuleDef): WebhookModuleDef {
  return {
    ...DEFAULT_WEBHOOK,
    ...def,
    module: "webhook",
    retries: { ...DEFAULT_WEBHOOK.retries, ...(def.retries ?? {}) },
  };
}

// ── Rate Limit Defaults ─────────────────────────────────────────────────────

const DEFAULT_RATELIMIT: Required<Omit<RateLimitModuleDef, "module">> & {
  module: "ratelimit";
} = {
  module: "ratelimit",
  algorithm: "sliding-window",
  failOpen: false,
  jitter: 0.1,
  gcIntervalMs: 300_000,
  eventRetentionMs: 86_400_000,
  statsFlushIntervalMs: 0,
  disabledBehavior: "skip",
  maxIdleMs: 3_600_000,
};

function applyRateLimitDefaults(def: RateLimitModuleDef): RateLimitModuleDef {
  return {
    ...DEFAULT_RATELIMIT,
    ...def,
    module: "ratelimit",
  };
}

// ── Batch Defaults ──────────────────────────────────────────────────────────

const DEFAULT_BATCH: Required<
  Omit<
    BatchModuleDef,
    | "module"
    | "lagMonitor"
    | "disabledBehavior"
    | "maxHeldJobs"
    | "removeOnComplete"
    | "removeOnFail"
  >
> & {
  module: "batch";
} = {
  module: "batch",
  tickIntervalMs: 1_000,
  concurrency: 1,
  heartbeatMs: 5_000,
  lockTtlMs: 30_000,
  leaderElection: true,
  shutdownTimeout: 25_000,
};

function applyBatchDefaults(def: BatchModuleDef): BatchModuleDef {
  return {
    ...DEFAULT_BATCH,
    ...def,
    module: "batch",
  };
}

// ── Main Config Schema ──────────────────────────────────────────────────────

export const OqronConfigSchema = z.object({
  project: z.string().optional(),
  environment: z.string().default("development"),

  // Storage mode
  mode: z
    .enum(["default", "db", "redis", "hybrid-db", "custom"])
    .default("default"),

  // Infrastructure
  redis: z.any().optional(),

  // PostgreSQL
  postgres: z
    .object({
      connectionString: z.string(),
      tablePrefix: postgresIdentifier.default("oqron"),
      poolSize: positiveInt.default(10),
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

  observability: z
    .object({
      maxJobLogs: nonNegativeInt.default(200),
      maxTimelineEntries: nonNegativeInt.default(20),
      trackMemory: z.boolean().default(true),
      logCollector: z.boolean().default(true),
      logCollectorMaxGlobal: nonNegativeInt.default(500),
      logCollectorMaxPerCategory: nonNegativeInt.default(200),
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
        .optional()
        .refine(
          (auth) =>
            !auth ||
            (!auth.username && !auth.password) ||
            (!!auth.username && !!auth.password),
          {
            message: "ui.auth requires both username and password, or neither",
          },
        ),
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
      timeout: positiveInt.default(30000),
      signals: z.array(z.string().min(1)).default(["SIGINT", "SIGTERM"]),
    })
    .default({}),
});

export type ValidatedConfig = Omit<
  z.infer<typeof OqronConfigSchema>,
  "modules"
> & {
  /** Normalized and default-merged module definitions */
  modules: OqronModuleDef[];
  /** Custom adapter implementations (passthrough — not Zod-validated) */
  adapters?: {
    storage: import("../types/engine.js").IStorageEngine;
    broker: import("../types/engine.js").IBrokerEngine;
    lock: import("../types/engine.js").ILockAdapter;
  };
};
