import { describe, expect, it, beforeEach } from "vitest";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";

describe("Atomic Transition (MemoryBroker)", () => {
  let broker: MemoryBroker;

  beforeEach(() => {
    broker = new MemoryBroker();
  });

  // MemoryBroker doesn't implement atomicTransition natively as it's just in memory 
  // and the 2-step process works fine, but we can verify the fallback structure
  // by ensuring it doesn't throw if we call it. However, since it's optional,
  // we check if it exists or test the logic that would use it.
  
  it("should not have atomicTransition natively on memory broker", () => {
    expect((broker as any).atomicTransition).toBeUndefined();
  });
});
