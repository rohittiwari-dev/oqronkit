import { describe, expect, it, beforeEach } from "vitest";
import { MemoryQueueAdapter } from "../../src/queue/adapters/memory-queue.js";
import { OqronJobData } from "../../src/core/types/queue.types.js";

describe("MemoryQueueAdapter", () => {
  let adapter: MemoryQueueAdapter;

  beforeEach(() => {
    adapter = new MemoryQueueAdapter();
  });

  describe("enqueue and claimJobs", () => {
    it("should enqueue a job and allow a worker to claim it", async () => {
      const jobData = { msg: "hello queue" };
      const job = await adapter.enqueue("test-q", jobData);

      expect(job.status).toBe("waiting");
      expect(job.queueName).toBe("test-q");
      expect(job.data).toEqual(jobData);

      const claimed = await adapter.claimJobs("test-q", 1, "worker-1", 30000);
      expect(claimed.length).toBe(1);

      const claimedJob = claimed[0];
      expect(claimedJob.status).toBe("active");
      expect(claimedJob.workerId).toBe("worker-1");
      expect(claimedJob.attemptMade).toBe(1);
    });

    it("should natively deduplicate if the same custom jobId is pushed", async () => {
      await adapter.enqueue("test-q", { id: 1 }, { jobId: "unique-123" });
      const job2 = await adapter.enqueue(
        "test-q",
        { id: 2 },
        { jobId: "unique-123" },
      );

      expect(job2.data.id).toBe(1); // It strictly returns the FIRST existing data

      const claimed = await adapter.claimJobs("test-q", 10, "worker-1", 30000);
      expect(claimed.length).toBe(1); // Only 1 job in queue due to deduplication
    });
  });

  describe("completion and failures", () => {
    it("should resolve a successfully completed job", async () => {
      const job = await adapter.enqueue(
        "test-q",
        { math: 1 + 1 },
        { jobId: "resolve" },
      );
      await adapter.claimJobs("test-q", 1, "worker-1", 30000);

      await adapter.completeJob("resolve", { result: 2 });

      const stored = await adapter.getJob("resolve");
      expect(stored?.status).toBe("completed");
      expect(stored?.returnValue).toEqual({ result: 2 });
    });

    it("should immediately remove job if removeOnComplete is true", async () => {
      await adapter.enqueue(
        "test-q",
        {},
        { jobId: "clean", removeOnComplete: true },
      );
      await adapter.claimJobs("test-q", 1, "worker-1", 30000);
      await adapter.completeJob("clean", "done");

      const stored = await adapter.getJob("clean");
      expect(stored).toBeNull();
    });

    it("should apply backoff status if retries allowed", async () => {
      await adapter.enqueue("test-q", {}, { jobId: "fail-1", attempts: 3 });
      await adapter.claimJobs("test-q", 1, "worker-1", 30000);

      await adapter.failJob("fail-1", "Simulated crashed");

      const stored = await adapter.getJob("fail-1");
      expect(stored?.status).toBe("delayed"); // Engine pushes back to waiting later
      expect(stored?.failedReason).toBe("Simulated crashed");
      expect(stored?.attemptMade).toBe(1);
    });

    it("should permanently fail if out of attempts", async () => {
      await adapter.enqueue("test-q", {}, { jobId: "fail-2", attempts: 1 });
      await adapter.claimJobs("test-q", 1, "worker-1", 30000); // attempt = 1

      await adapter.failJob("fail-2", "Fatal error");

      const stored = await adapter.getJob("fail-2");
      expect(stored?.status).toBe("failed");
    });
  });
});
