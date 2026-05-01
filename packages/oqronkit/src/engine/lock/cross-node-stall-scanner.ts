import type { Logger } from "../logger/index.js";
import type { ILockAdapter, IStorageEngine } from "../types/engine.js";
import type { OqronJob } from "../types/job.types.js";

/**
 * F9: Cross-Node Stall Scanner
 *
 * Unlike the local `StallDetector` (which only checks heartbeats for jobs
 * owned by the current node), the `CrossNodeStallScanner` queries the storage
 * layer directly for ALL jobs in "active" status and verifies their locks.
 *
 * This catches the case where a node crashes hard (SIGKILL/OOM) and its
 * local StallDetector never fires. Any surviving node running this scanner
 * will find the orphaned jobs and reclaim them.
 *
 * **Usage:** Enable via `crossNodeStallScanner: true` in the queue/worker
 * module config. Only ONE node needs to run it (use leader election for
 * multi-node setups).
 *
 * **How it works:**
 * 1. Queries storage for all jobs with status="active"
 * 2. For each, checks if a valid lock exists via `lock.isOwner()`
 * 3. If no lock exists, the job's worker has crashed — reclaim it
 * 4. Emits `job:stalled` event and nacks the job back to the broker
 */
export class CrossNodeStallScanner {
  private timer?: ReturnType<typeof setInterval>;
  private scanning = false;

  constructor(
    private readonly storage: IStorageEngine,
    private readonly lock: ILockAdapter,
    private readonly logger: Logger,
    private readonly config: {
      /** How often to scan (ms). @default 30000 */
      intervalMs?: number;
      /** Lock key prefix (e.g. "queue" or "worker"). @default "queue" */
      lockPrefix?: string;
      /** Max stall count before marking as permanently failed. @default 3 */
      maxStalledCount?: number;
      /** Queue/topic names to scan. If empty, scans all active jobs. */
      queueNames?: string[];
    } = {},
  ) {}

  /**
   * Start the periodic cross-node scan.
   * @param onStalled Called for each orphaned job found. Receives the full job record.
   */
  start(
    onStalled: (job: OqronJob) => Promise<void> | void,
  ): void {
    const intervalMs = this.config.intervalMs ?? 30_000;
    const prefix = this.config.lockPrefix ?? "queue";

    this.logger.info("CrossNodeStallScanner started", {
      intervalMs,
      prefix,
      queueNames: this.config.queueNames ?? "all",
    });

    this.timer = setInterval(async () => {
      if (this.scanning) return; // Skip if previous scan is still running
      this.scanning = true;

      try {
        await this.scan(prefix, onStalled);
      } catch (err) {
        this.logger.error("CrossNodeStallScanner tick error", {
          err: String(err),
        });
      } finally {
        this.scanning = false;
      }
    }, intervalMs);
    this.timer.unref();
  }

  /**
   * Run a single scan pass (public for testing).
   */
  async scan(
    prefix: string,
    onStalled: (job: OqronJob) => Promise<void> | void,
  ): Promise<number> {
    const activeStatuses = ["active", "running"];

    // If specific queue names are configured, scan only those
    const queueNames = this.config.queueNames;

    let activeJobs: OqronJob[];
    if (queueNames?.length) {
      // Scan each queue separately
      activeJobs = [];
      for (const qn of queueNames) {
        for (const status of activeStatuses) {
          const jobs = await this.storage.list<OqronJob>("jobs", {
            status,
            queueName: qn,
          }, { limit: 1000 });
          activeJobs.push(...jobs);
        }
      }
    } else {
      activeJobs = [];
      for (const status of activeStatuses) {
        const jobs = await this.storage.list<OqronJob>("jobs", { status }, {
          limit: 10_000,
        });
        activeJobs.push(...jobs);
      }
    }

    if (activeJobs.length === 0) return 0;

    let stalledCount = 0;
    const maxStalledCount = this.config.maxStalledCount ?? 3;

    for (const job of activeJobs) {
      // Skip jobs without a workerId — they haven't been claimed yet
      if (!job.workerId) continue;

      const lockKey = `${prefix}:job:${job.id}`;
      const hasValidLock = await this.lock.isOwner(lockKey, job.workerId);

      if (!hasValidLock) {
        // The lock has expired — the worker has crashed
        const jobStalledCount = (job.stalledCount ?? 0) + 1;

        this.logger.warn("Cross-node stall detected — orphaned job found", {
          jobId: job.id,
          queueName: job.queueName,
          workerId: job.workerId,
          stalledCount: jobStalledCount,
          maxStalledCount,
        });

        // Update job record
        job.stalledCount = jobStalledCount;
        job.status = "stalled";
        if (!job.timeline) job.timeline = [];
        job.timeline.push({
          ts: new Date(),
          from: job.status,
          to: "stalled",
          reason: `Cross-node scan: Worker ${job.workerId} lock expired`,
        });

        // If exceeded max stalls, mark as permanently failed
        if (jobStalledCount >= maxStalledCount) {
          job.status = "failed";
          job.error = `Exceeded maxStalledCount (${maxStalledCount}). Job abandoned.`;
          job.finishedAt = new Date();
          job.timeline.push({
            ts: new Date(),
            from: "stalled",
            to: "failed",
            reason: `Stalled ${jobStalledCount} times — permanently failed`,
          });
        }

        await this.storage.save("jobs", job.id, job);
        await onStalled(job);
        stalledCount++;
      }
    }

    if (stalledCount > 0) {
      this.logger.info(`CrossNodeStallScanner found ${stalledCount} stalled jobs`);
    }

    return stalledCount;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Whether a scan is currently in progress */
  get isScanning(): boolean {
    return this.scanning;
  }
}
