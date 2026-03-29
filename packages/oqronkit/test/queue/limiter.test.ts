import { randomUUID } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryAdapter } from "../../src/adapters/memory.adapter.js";

describe("Worker Concurrency Limiter (Sliding Window)", () => {
  let adapter: MemoryAdapter;

  beforeEach(() => {
    adapter = new MemoryAdapter();
  });

  it("limits claimed jobs based on sliding window max/duration", async () => {
    const queue = "webhook-queue";
    // 1. Enqueue 5 jobs via Dual-Storage flow
    for (let i = 1; i <= 5; i++) {
      const id = `j${i}`;
      await adapter.upsertJob({
        id, type: 'task', queueName: queue, status: 'waiting', 
        data: { id: i }, opts: {}, attemptMade: 0, progressPercent: 0, tags: [], createdAt: new Date()
      });
      await adapter.signalEnqueue(queue, id);
    }

    // 2. Claim jobs with a strict limiter of 2 per 1000ms
    const limiter = { max: 2, duration: 1000 };
    
    // First claim should pull exactly 2 jobs (hits max constraint)
    const claimedFirst = await adapter.claimJobIds("webhook-queue", "worker-1", 5, 10000, limiter);
    expect(claimedFirst).toHaveLength(2);

    // Immediate second claim should pull 0 jobs (still within the 1000ms window)
    const claimedSecond = await adapter.claimJobIds("webhook-queue", "worker-1", 5, 10000, limiter);
    expect(claimedSecond).toHaveLength(0);

    // 3. Fast-forward time manually by mocking Date to expire the sliding window
    const realDateNow = Date.now;
    vi.spyOn(Date, "now").mockReturnValue(realDateNow() + 1500);

    // Fourth claim should pull the next 2 jobs because the window expired
    const claimedThird = await adapter.claimJobIds("webhook-queue", "worker-1", 5, 10000, limiter);
    expect(claimedThird).toHaveLength(2);
    
    vi.restoreAllMocks();
  });

  it("ignores rate limiting if jobs belong to a different groupKey", async () => {
    const queue = "test-queue";
    await adapter.upsertJob({ id: 'j1', type: 'task', queueName: queue, status: 'waiting', data: {}, opts: {}, attemptMade: 0, progressPercent: 0, tags: [], createdAt: new Date() });
    await adapter.upsertJob({ id: 'j2', type: 'task', queueName: queue, status: 'waiting', data: {}, opts: {}, attemptMade: 0, progressPercent: 0, tags: [], createdAt: new Date() });
    await adapter.signalEnqueue(queue, 'j1');
    await adapter.signalEnqueue(queue, 'j2');

    // Custom groupKey claim
    const claim1 = await adapter.claimJobIds(queue, "bob", 5, 10000, { max: 1, duration: 2000, groupKey: "tenantA" });
    expect(claim1).toHaveLength(1);

    // Immediate claim from same tenant ignores
    const claim2 = await adapter.claimJobIds(queue, "bob", 5, 10000, { max: 1, duration: 2000, groupKey: "tenantA" });
    expect(claim2).toHaveLength(0);

    // Immediate claim from different tenant succeeds
    const claim3 = await adapter.claimJobIds(queue, "bob", 5, 10000, { max: 1, duration: 2000, groupKey: "tenantB" });
    expect(claim3).toHaveLength(1);
  });
});
