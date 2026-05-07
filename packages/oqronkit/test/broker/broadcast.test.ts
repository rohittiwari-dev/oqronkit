import { describe, expect, it } from "vitest";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";

describe("Broker broadcast", () => {
  it("fans out messages to every memory subscriber and supports unsubscribe", async () => {
    const broker = new MemoryBroker();
    const receivedA: unknown[] = [];
    const receivedB: unknown[] = [];

    const unsubA = await broker.subscribe!("cache:invalidation", (message) => {
      receivedA.push(message);
    });
    const unsubB = await broker.subscribe!("cache:invalidation", (message) => {
      receivedB.push(message);
    });

    await broker.broadcast!("cache:invalidation", { key: "a" });
    expect(receivedA).toEqual([{ key: "a" }]);
    expect(receivedB).toEqual([{ key: "a" }]);

    unsubA();
    await broker.broadcast!("cache:invalidation", { key: "b" });
    expect(receivedA).toEqual([{ key: "a" }]);
    expect(receivedB).toEqual([{ key: "a" }, { key: "b" }]);

    unsubB();
    broker.close();
  });
});
