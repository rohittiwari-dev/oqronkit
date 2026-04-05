import { describe, it, expect, beforeEach } from "vitest";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";

describe("Broker nack() — Crash-Safe Retry", () => {
  let broker: MemoryBroker;

  beforeEach(() => {
    broker = new MemoryBroker();
  });

  it("should re-queue a job immediately when nack is called without delay", async () => {
    await broker.publish("test-queue", "job-1");

    // Claim it
    const claimed = await broker.claim("test-queue", "w1", 1, 30000);
    expect(claimed).toEqual(["job-1"]);

    // Nothing else to claim
    const empty = await broker.claim("test-queue", "w1", 1, 30000);
    expect(empty).toEqual([]);

    // Nack it — should go back to front of waiting list
    await broker.nack("test-queue", "job-1");

    // Now it should be claimable again
    const reclaimed = await broker.claim("test-queue", "w2", 1, 30000);
    expect(reclaimed).toEqual(["job-1"]);
  });

  it("should re-queue a job with delay when nack is called with delayMs", async () => {
    await broker.publish("test-queue", "job-2");

    const claimed = await broker.claim("test-queue", "w1", 1, 30000);
    expect(claimed).toEqual(["job-2"]);

    // Nack with 50ms delay
    await broker.nack("test-queue", "job-2", 50);

    // Immediate claim should find nothing — job is in delayed set
    const immediate = await broker.claim("test-queue", "w2", 1, 30000);
    expect(immediate).toEqual([]);

    // Wait for delay to expire
    await new Promise((r) => setTimeout(r, 60));

    // Now the job should be promotable and claimable
    const reclaimed = await broker.claim("test-queue", "w2", 1, 30000);
    expect(reclaimed).toEqual(["job-2"]);
  });

  it("should release the lock when nack is called", async () => {
    await broker.publish("test-queue", "job-3");
    await broker.claim("test-queue", "w1", 1, 30000);

    // Lock should exist and extending should work
    await broker.extendLock("job-3", "w1", 30000);

    // Nack releases the lock
    await broker.nack("test-queue", "job-3");

    // Lock should be gone — extending should throw
    await expect(
      broker.extendLock("job-3", "w1", 30000),
    ).rejects.toThrow();
  });
});

describe("Broker pause/resume", () => {
  let broker: MemoryBroker;

  beforeEach(() => {
    broker = new MemoryBroker();
  });

  it("should prevent claiming when paused", async () => {
    await broker.publish("test-queue", "job-1");
    await broker.pause("test-queue");

    const claimed = await broker.claim("test-queue", "w1", 1, 30000);
    expect(claimed).toEqual([]);

    await broker.resume("test-queue");
    const reclaimed = await broker.claim("test-queue", "w1", 1, 30000);
    expect(reclaimed).toEqual(["job-1"]);
  });
});
