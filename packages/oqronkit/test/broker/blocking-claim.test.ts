import { describe, expect, it, beforeEach } from "vitest";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";

describe("Blocking Claims (MemoryBroker)", () => {
  let broker: MemoryBroker;

  beforeEach(() => {
    broker = new MemoryBroker();
  });

  it("should return immediately if job already exists", async () => {
    await broker.publish("q1", "job-1");
    const t0 = Date.now();
    const id = await broker.claimBlocking!("q1", "w1", 1000, 5000);
    const dt = Date.now() - t0;
    
    expect(id).toBe("job-1");
    expect(dt).toBeLessThan(100); // very fast
  });

  it("should block until job arrives", async () => {
    const claimPromise = broker.claimBlocking!("q1", "w1", 1000, 5000);
    
    setTimeout(() => {
      broker.publish("q1", "job-2");
    }, 100);

    const id = await claimPromise;
    expect(id).toBe("job-2");
  });

  it("should timeout and return null if no job arrives", async () => {
    const t0 = Date.now();
    const id = await broker.claimBlocking!("q1", "w1", 1000, 200);
    const dt = Date.now() - t0;

    expect(id).toBeNull();
    expect(dt).toBeGreaterThanOrEqual(190); // took at least timeout amount
  });
});
