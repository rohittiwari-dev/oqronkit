import type { ClusteringConfig, DisabledBehavior } from "./engine/types/config.types.js";
import type { BrokerStrategy } from "./engine/types/engine.js";
import type { RemoveOnConfig } from "./engine/types/job.types.js";

// ── Module Names ────────────────────────────────────────────────────────────

export type OqronModuleName =
  | "cron"
  | "scheduler"
  | "queue"
  | "workflow"
  | "batch"
  | "webhook"
  | "pipeline";

// ── Per-Module Config Interfaces (user-facing, all optional) ────────────────

export interface CronModuleConfig {
  /** Global timezone fallback when a cron def doesn't specify one. @default "UTC" */
  timezone?: string;
  /** Tick interval in ms for the cron polling loop. @default 1000 */
  tickInterval?: number;
  /** Default missed-fire policy. @default "run-once" */
  missedFirePolicy?: "skip" | "run-once" | "run-all";
  /** Global max concurrent cron jobs. @default 5 */
  maxConcurrentJobs?: number;
  /** Enable cluster-wide leader election. @default true */
  leaderElection?: boolean;
  /** Rolling execution history. `true` = infinite, `false` = 0, `number` = keep N */
  keepJobHistory?: boolean | number;
  /** Override for failed tasks retention */
  keepFailedJobHistory?: boolean | number;
  /** Graceful shutdown drain timeout in ms. @default 25000 */
  shutdownTimeout?: number;
  /** Lag monitor thresholds */
  lagMonitor?: { maxLagMs?: number; sampleIntervalMs?: number };
  /** Sharded leader election for multi-region cron distribution */
  clustering?: ClusteringConfig;
  /**
   * Default behavior when a disabled cron instance fires.
   * Individual cron definitions can override this.
   * @default "hold"
   */
  disabledBehavior?: DisabledBehavior;
}

export interface SchedulerModuleConfig {
  /** Tick interval in ms. @default 1000 */
  tickInterval?: number;
  /** Global timezone fallback. @default "UTC" */
  timezone?: string;
  /** Enable cluster-wide leader election. @default true */
  leaderElection?: boolean;
  /** Rolling execution history retention */
  keepJobHistory?: boolean | number;
  /** Failed job history retention */
  keepFailedJobHistory?: boolean | number;
  /** Graceful shutdown drain timeout in ms. @default 25000 */
  shutdownTimeout?: number;
  /** Lag monitor thresholds */
  lagMonitor?: { maxLagMs?: number; sampleIntervalMs?: number };
  /** Sharded leader election for multi-region schedule distribution */
  clustering?: ClusteringConfig;
  /**
   * Default behavior when a disabled schedule instance fires.
   * Individual schedule definitions can override this.
   * @default "hold"
   */
  disabledBehavior?: DisabledBehavior;
}

export interface QueueModuleConfig {
  /** Parallel execution limit. @default 5 */
  concurrency?: number;
  /** Polling interval in ms. @default 5000 */
  heartbeatMs?: number;
  /** Lock TTL in ms for crash recovery. @default 30000 */
  lockTtlMs?: number;
  /** Job ordering strategy. @default "fifo" */
  strategy?: BrokerStrategy;
  /** Default retry configuration for all queues */
  retries?: {
    max?: number;
    strategy?: "fixed" | "exponential";
    baseDelay?: number;
    maxDelay?: number;
  };
  /** Dead letter queue configuration */
  deadLetter?: { enabled?: boolean };
  /** Global default: auto-remove completed jobs. @default false */
  removeOnComplete?: RemoveOnConfig;
  /** Global default: auto-remove failed jobs. @default false */
  removeOnFail?: RemoveOnConfig;
  /** Graceful shutdown drain timeout in ms. @default 25000 */
  shutdownTimeout?: number;
  /** Max stalled job retries before marking as permanently failed. @default 1 */
  maxStalledCount?: number;
  /** Stalled check interval in ms. @default 30000 */
  stalledInterval?: number;
  /**
   * Default behavior when a disabled queue instance receives a new job.
   * Individual queue definitions can override this.
   * @default "hold"
   */
  disabledBehavior?: DisabledBehavior;
}

// ── Discriminated Union (resolved module definitions) ───────────────────────

export type CronModuleDef = { module: "cron" } & CronModuleConfig;
export type SchedulerModuleDef = {
  module: "scheduler";
} & SchedulerModuleConfig;
export type QueueModuleDef = { module: "queue" } & QueueModuleConfig;

export type OqronModuleDef =
  | CronModuleDef
  | SchedulerModuleDef
  | QueueModuleDef;

// ── Flexible Input Type ─────────────────────────────────────────────────────
// Users can pass any of these forms inside the `modules` array:
//   1. "cron"                         — string shorthand (all defaults)
//   2. { module: "cron", ... }        — inline object
//   3. cronModule                     — factory reference (no args, defaults)
//   4. cronModule({ tickInterval: 500 }) — factory invoked (returns OqronModuleDef)

export type OqronModuleInput =
  | OqronModuleName
  | OqronModuleDef
  | (() => OqronModuleDef);

// ── Factory Functions ───────────────────────────────────────────────────────

/**
 * Create a Cron module configuration.
 * Can be passed directly or invoked with overrides.
 *
 * @example
 * modules: [cronModule]                              // defaults
 * modules: [cronModule({ tickInterval: 500 })]       // with overrides
 * modules: [cronModule()]                             // explicit defaults
 */
export function cronModule(config?: CronModuleConfig): CronModuleDef {
  return { module: "cron", ...config };
}

/**
 * Create a Scheduler module configuration.
 *
 * @example
 * modules: [scheduleModule]
 * modules: [scheduleModule({ leaderElection: false })]
 */
export function scheduleModule(
  config?: SchedulerModuleConfig,
): SchedulerModuleDef {
  return { module: "scheduler", ...config };
}

/**
 * Create a Queue module configuration.
 *
 * @example
 * modules: [queueModule]
 * modules: [queueModule({ concurrency: 20 })]
 */
export function queueModule(config?: QueueModuleConfig): QueueModuleDef {
  return { module: "queue", ...config };
}

// ── Normalizer ──────────────────────────────────────────────────────────────
// Converts all flexible input forms into a uniform OqronModuleDef[].

const STRING_TO_DEF: Record<OqronModuleName, () => OqronModuleDef> = {
  cron: () => ({ module: "cron" }),
  scheduler: () => ({ module: "scheduler" }),
  queue: () => ({ module: "queue" }),
  workflow: () => ({ module: "queue" }), // placeholder until workflow module exists
  batch: () => ({ module: "queue" }), // placeholder
  webhook: () => ({ module: "queue" }), // placeholder
  pipeline: () => ({ module: "queue" }), // placeholder
};

/**
 * Normalize a mixed `modules` array into a clean `OqronModuleDef[]`.
 * Handles strings, objects, and factory functions (with or without invocation).
 */
export function normalizeModules(inputs: OqronModuleInput[]): OqronModuleDef[] {
  const seen = new Set<string>();
  const result: OqronModuleDef[] = [];

  for (const input of inputs) {
    let def: OqronModuleDef;

    if (typeof input === "string") {
      // "cron" → { module: "cron" }
      const factory = STRING_TO_DEF[input];
      if (!factory) {
        throw new Error(`[OqronKit] Unknown module name: "${input}"`);
      }
      def = factory();
    } else if (typeof input === "function") {
      // cronModule (passed as reference without invocation)
      def = input();
    } else if (
      typeof input === "object" &&
      input !== null &&
      "module" in input
    ) {
      // { module: "cron", tickInterval: 500 }
      def = input;
    } else {
      throw new Error(
        `[OqronKit] Invalid module entry. Expected a string, object with 'module' key, or factory function. Got: ${typeof input}`,
      );
    }

    // Deduplicate by module name — last one wins
    if (seen.has(def.module)) {
      const idx = result.findIndex((r) => r.module === def.module);
      if (idx >= 0) result.splice(idx, 1);
    }
    seen.add(def.module);
    result.push(def);
  }

  return result;
}

/**
 * Extract a specific module config from a normalized modules array.
 * Returns undefined if the module is not present.
 */
export function getModuleConfig<T extends OqronModuleDef>(
  modules: OqronModuleDef[],
  name: T["module"],
): T | undefined {
  return modules.find((m) => m.module === name) as T | undefined;
}
