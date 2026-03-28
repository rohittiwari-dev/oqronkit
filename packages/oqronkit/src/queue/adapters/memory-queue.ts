import crypto from "node:crypto";
import type {
  IQueueAdapter,
  OqronJobData,
  OqronJobOptions,
} from "../../core/types/queue.types.js";

export class MemoryQueueAdapter implements IQueueAdapter {
  private jobs: Map<string, OqronJobData> = new Map();

  private generateId(): string {
    return crypto.randomUUID();
  }

  async enqueue<T>(
    queueName: string,
    data: T,
    opts?: OqronJobOptions,
  ): Promise<OqronJobData<T>> {
    // Deduplication natively handled if opts.jobId is passed and exists
    const jobId = opts?.jobId || this.generateId();
    if (opts?.jobId && this.jobs.has(jobId)) {
      return this.jobs.get(jobId) as OqronJobData<T>;
    }

    const job: OqronJobData<T> = {
      id: jobId,
      queueName,
      data,
      opts,
      attemptMade: 0,
      status: opts?.delay ? "delayed" : "waiting",
      createdAt: new Date(),
      progressPercent: 0,
    };

    /**
     * If delayed, we spoof nextRun by mapping it outside adapter strictly,
     * but purely in-memory we can just track waiting vs delayed status.
     * Real backoff logic triggers a timeout on the engine side or natively here.
     */

    this.jobs.set(job.id, job);
    return job;
  }

  async enqueueBulk<T>(
    queueName: string,
    jobs: { data: T; opts?: OqronJobOptions }[],
  ): Promise<OqronJobData<T>[]> {
    const results: OqronJobData<T>[] = [];
    for (const j of jobs) {
      results.push(await this.enqueue(queueName, j.data, j.opts));
    }
    return results;
  }

  async claimJobs(
    queueName: string,
    limit: number,
    workerId: string,
    _lockTtlMs: number,
  ): Promise<OqronJobData[]> {
    const claimed: OqronJobData[] = [];
    const now = new Date();

    // Iterate map in insertion order (FIFO roughly)
    for (const job of this.jobs.values()) {
      if (claimed.length >= limit) break;

      // Simplistic claim matching
      if (job.status === "waiting" && job.queueName === queueName) {
        job.status = "active";
        job.workerId = workerId;
        job.startedAt = now;
        job.attemptMade += 1;
        claimed.push(job);
      }
    }
    return claimed;
  }

  async extendLock(
    jobId: string,
    workerId: string,
    _lockTtlMs: number,
  ): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);
    if (job.workerId !== workerId)
      throw new Error(`Lock stolen from worker ${workerId}`);
    // In-memory doesn't use TTL eviction like Redis natively, so extendLock is effectively a no-op
    // outside of verifying the worker still owns it.
  }

  async completeJob(jobId: string, returnValue?: any): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.status = "completed";
    job.finishedAt = new Date();
    job.returnValue = returnValue;

    if (job.opts?.removeOnComplete === true) {
      this.jobs.delete(jobId);
    }
  }

  async failJob(
    jobId: string,
    reason: string,
    stacktrace?: string,
  ): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.failedReason = reason;
    if (stacktrace) {
      job.stacktrace = job.stacktrace
        ? [...job.stacktrace, stacktrace]
        : [stacktrace];
    }

    const maxAttempts = job.opts?.attempts || 1;
    if (job.attemptMade < maxAttempts) {
      job.status = "delayed"; // Engine will push it back to waiting after backoff
    } else {
      job.status = "failed";
    }

    job.finishedAt = new Date();

    if (job.status === "failed" && job.opts?.removeOnFail === true) {
      this.jobs.delete(jobId);
    }
  }

  async updateProgress(
    jobId: string,
    percent: number,
    label?: string,
  ): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.progressPercent = percent;
    if (label) job.progressLabel = label;
  }

  async getJob(jobId: string): Promise<OqronJobData | null> {
    return this.jobs.get(jobId) || null;
  }

  async removeJob(jobId: string): Promise<void> {
    this.jobs.delete(jobId);
  }
}
