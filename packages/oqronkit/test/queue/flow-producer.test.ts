import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { OqronKit, FlowProducer, taskQueue } from "../../src/index.js";
import { OqronRegistry } from "../../src/core/index.js";

describe.skip("Server-Independent module: FlowProducer (DAG Dependencies)", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await OqronKit.stop();
    OqronRegistry.getInstance()._reset();
  });

  it("should delay parent job execution until all dependent children complete", async () => {
    let parentFired = false;
    let kidsFinished = 0;

    const childQueue = taskQueue({
      name: "dag-children",
      handler: async () => {
        kidsFinished++;
        return "kid-done";
      }
    });

    const parentQueue = taskQueue({
      name: "dag-parents",
      handler: async () => {
        parentFired = true;
        return "parent-done";
      }
    });

    const producer = new FlowProducer();

    // Re-init so registries capture the dynamically defined queues
    await OqronKit.init({ config: { project: "test", environment: "test", modules: ["taskQueue"], db: { adapter: 'memory' } } });

    // Enqueue Flow precisely matching BullMQ API
    await producer.add({
      name: "run-pipeline",
      queueName: "dag-parents",
      data: { masterId: 1 },
      children: [
        { name: "step-1", queueName: "dag-children", data: { val: "a" } },
        { name: "step-2", queueName: "dag-children", data: { val: "b" } },
      ]
    });

    // Advance roughly enough time for children to evaluate
    await vi.advanceTimersByTimeAsync(100);

    // Because memory adapter synchronously handles the completions mapping natively, 
    // the parent is unlocked seamlessly.
    expect(kidsFinished).toBe(2);
    expect(parentFired).toBe(true);
  });
});
