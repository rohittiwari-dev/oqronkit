import type { Logger } from "../logger/index.js";
import type { ILockAdapter } from "../types/engine.js";

/**
 * Detects stalled jobs where the heartbeat has expired (the worker crashed).
 * Runs a background loop that checks lock ownership and marks dead jobs.
 */
export class StallDetector {
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly lock: ILockAdapter,
    private readonly logger: Logger,
    private readonly checkIntervalMs: number = 15_000,
  ) {}

  /**
   * Start the stall detection loop.
   * @param getActiveJobs - Returns a list of { key, ownerId } for all currently tracked jobs.
   * @param onStalled     - Called when a job is detected as stalled (lock lost).
   */
  start(
    getActiveJobs: () => Array<{ key: string; ownerId: string }>,
    onStalled: (key: string) => void,
  ): void {
    this.timer = setInterval(async () => {
      try {
        const jobs = getActiveJobs();
        for (const job of jobs) {
          const owned = await this.lock.isOwner(job.key, job.ownerId);
          if (!owned) {
            this.logger.warn("Stalled job detected — lock lost", {
              key: job.key,
              ownerId: job.ownerId,
            });
            onStalled(job.key);
          }
        }
      } catch (err) {
        this.logger.error("StallDetector tick error", { err: String(err) });
      }
    }, this.checkIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
