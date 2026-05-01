/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  OqronKit — Universal Job Retention / Pruning Utility
 *
 *  Implements lazy removal: jobs are pruned only when new completions/failures
 *  happen, NOT via background timer. This avoids unnecessary polling and scales.
 *
 *  All 4 engines (Cron, Schedule, TaskQueue, Worker) call this single
 *  utility after job finalization.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { Storage } from "../core.js";
import type { KeepJobs, RemoveOnConfig } from "../types/job.types.js";

export interface PruneOptions {
  /** Storage namespace: "jobs" (unified) */
  namespace: string;

  /** The ID of the job that just completed/failed (used for immediate removal) */
  jobId: string;

  /** Whether the job completed or failed */
  status: "completed" | "failed";

  /**
   * Per-job retention override (from `OqronJobOptions.removeOnComplete/Fail`).
   * This takes highest priority.
   */
  jobRemoveConfig?: RemoveOnConfig;

  /**
   * Queue/module-level default (from `TaskQueueConfig.removeOnComplete/Fail`
   * or `CronConfig.keepHistory`).
   */
  moduleRemoveConfig?: RemoveOnConfig;

  /**
   * Global config-level default (from `OqronConfig.taskQueue.removeOnComplete`
   * or `OqronConfig.cron.keepJobHistory`).
   */
  globalRemoveConfig?: RemoveOnConfig;

  /**
   * Optional filter key for scoped pruning (e.g., prune only jobs for a
   * specific cron name). Key is the property name on the stored record,
   * value is the expected value.
   *
   * Example: { key: "scheduleId", value: "daily-billing" }
   */
  filterKey?: string;
  filterValue?: string;
}

/**
 * Resolves the effective retention config from the cascade:
 * job-level → module-level → global-level → default (keep all).
 */
function resolveConfig(opts: PruneOptions): RemoveOnConfig {
  const configForStatus =
    opts.status === "completed"
      ? (opts.jobRemoveConfig ??
        opts.moduleRemoveConfig ??
        opts.globalRemoveConfig)
      : (opts.jobRemoveConfig ??
        opts.moduleRemoveConfig ??
        opts.globalRemoveConfig);

  // Default: keep all (no pruning)
  return configForStatus ?? false;
}

/**
 * Normalize a KeepJobs / boolean / number into a KeepJobs object.
 */
function normalizeKeepJobs(
  config: RemoveOnConfig,
): KeepJobs | "remove" | "keep" {
  if (config === true) return "remove"; // Remove immediately
  if (config === false) return "keep"; // Keep forever
  if (typeof config === "number") return { count: config };
  return config; // Already a KeepJobs object
}

function toEpochMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  if (
    value &&
    typeof value === "object" &&
    (value as any).__type === "Date" &&
    typeof (value as any).__val === "string"
  ) {
    const parsed = new Date((value as any).__val).getTime();
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function getFinishedTime(record: any): number {
  return (
    toEpochMs(record.finishedOn) ||
    toEpochMs(record.finishedAt) ||
    toEpochMs(record.timestamp) ||
    toEpochMs(record.createdAt)
  );
}

/**
 * Universal lazy-pruning utility.
 * Called after every job finalization across ALL engines.
 *
 * Behavior:
 * - `true` → remove this job immediately
 * - `false` → keep forever
 * - `number` → keep N most recent, prune oldest
 * - `{ age, count }` → prune by age AND/OR count
 */
export async function pruneAfterCompletion(opts: PruneOptions): Promise<void> {
  const config = resolveConfig(opts);
  const normalized = normalizeKeepJobs(config);

  if (normalized === "keep") return; // No pruning

  if (normalized === "remove") {
    // Industrygrade `removeOnComplete: true` — immediate removal
    await Storage.delete(opts.namespace, opts.jobId);
    return;
  }

  // KeepJobs object — count-based and/or age-based pruning
  const { age, count } = normalized;

  if (!age && !count) return; // Nothing to prune

  try {
    // Fetch all records in this scope
    const filter: Record<string, string> = { status: opts.status };
    if (opts.filterKey && opts.filterValue) {
      filter[opts.filterKey] = opts.filterValue;
    }

    const allRecords = await Storage.list<any>(
      opts.namespace,
      filter,
    );

    const statusRecords = allRecords;

    // Sort by finishedOn/finishedAt descending (newest first)
    statusRecords.sort((a: any, b: any) => {
      return getFinishedTime(b) - getFinishedTime(a);
    });

    const toDelete: string[] = [];
    const now = Date.now();

    for (let i = 0; i < statusRecords.length; i++) {
      const record = statusRecords[i];
      let shouldDelete = false;

      // Count-based: keep only `count` most recent
      if (count !== undefined && i >= count) {
        shouldDelete = true;
      }

      // Age-based: remove older than `age` seconds
      if (age !== undefined) {
        const recordTime = getFinishedTime(record);
        if (now - recordTime > age * 1000) {
          shouldDelete = true;
        }
      }

      if (shouldDelete && record.id) {
        toDelete.push(record.id);
      }
    }

    // Batch delete
    for (const id of toDelete) {
      await Storage.delete(opts.namespace, id);
    }
  } catch {
    // Pruning is best-effort — never crash the engine
  }
}

// ── Convenience aliases for Cron/Schedule engine backward compatibility ──────

/**
 * Converts cron/schedule `keepHistory` (boolean | number) to Industrygrade-compatible
 * `removeOnComplete` config.
 *
 * Mapping:
 * - `true` (default) → `false` (keep all — no removal)
 * - `false` → `true` (remove immediately)
 * - `30` → `{ count: 30 }` (keep 30 most recent)
 */
export function keepHistoryToRemoveConfig(
  keepHistory?: boolean | number,
): RemoveOnConfig {
  if (keepHistory === undefined || keepHistory === true) return false; // Keep all
  if (keepHistory === false) return true; // Remove immediately
  return { count: keepHistory }; // Number → keep N
}
