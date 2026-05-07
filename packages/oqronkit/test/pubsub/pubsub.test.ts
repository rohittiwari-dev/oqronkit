import { afterEach, describe, expect, it } from "vitest";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";
import { MemoryStore } from "../../src/engine/memory/memory-store.js";
import { OqronKit, pubsubModule, topic } from "../../src/index.js";

const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
};

const uniqueName = (base: string) =>
  `${base}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const initPubSub = async () => {
  await OqronKit.init({
    config: {
      project: uniqueName("project"),
      environment: "test",
      triggers: false,
      logger: false,
      shutdown: { enabled: false },
      modules: [
        pubsubModule({
          pollIntervalMs: 10,
          lockTtlMs: 1000,
          ackTimeoutMs: 1000,
          reconciliationIntervalMs: 0,
          retentionIntervalMs: 0,
        }),
      ],
    },
  });
};

describe("PubSub", () => {
  afterEach(async () => {
    await OqronKit.stop();
  });

  it("publishes one message to multiple consumer groups", async () => {
    const events = topic<{ id: string }>({
      name: uniqueName("orders"),
      distribution: {
        partitions: 2,
        partitionKey: (message) => message.id,
      },
    });
    await initPubSub();

    const billing: string[] = [];
    const analytics: string[] = [];
    await events.subscribe({
      group: "billing",
      handler: async (ctx) => {
        billing.push(ctx.message.id);
      },
    });
    await events.subscribe({
      group: "analytics",
      handler: async (ctx) => {
        analytics.push(ctx.message.id);
      },
    });

    await events.publish({ id: "order-1" });

    await waitFor(() => billing.length === 1 && analytics.length === 1);
    expect(billing).toEqual(["order-1"]);
    expect(analytics).toEqual(["order-1"]);
    expect(await events.lag("billing")).toBe(0);
  });

  it("deduplicates idempotent publishes", async () => {
    const events = topic<{ value: number }>({ name: uniqueName("idem") });
    await initPubSub();

    const first = await events.publish(
      { value: 1 },
      { idempotencyKey: "same-operation" },
    );
    const second = await events.publish(
      { value: 2 },
      { idempotencyKey: "same-operation" },
    );

    expect(second).toBe(first);
    const stats = await events.stats();
    expect(stats.messageCount).toBe(1);
  });

  it("preserves ordering inside a keyed partition", async () => {
    const events = topic<{ accountId: string; seq: number }>({
      name: uniqueName("partitioned"),
      distribution: {
        partitions: 4,
        partitionKey: (message) => message.accountId,
      },
    });
    await initPubSub();

    const seen: number[] = [];
    await events.subscribe({
      group: "projection",
      concurrency: 4,
      handler: async (ctx) => {
        seen.push(ctx.message.seq);
      },
    });

    await events.publish({ accountId: "acct-1", seq: 1 });
    await events.publish({ accountId: "acct-1", seq: 2 });
    await events.publish({ accountId: "acct-1", seq: 3 });

    await waitFor(() => seen.length === 3);
    expect(seen).toEqual([1, 2, 3]);
  });

  it("moves exhausted retries to inspectable dead letters", async () => {
    const events = topic<{ id: string }>({ name: uniqueName("dlq") });
    await initPubSub();

    await events.subscribe({
      group: "failing",
      retries: { max: 1, strategy: "fixed", baseDelay: 10 },
      deadLetter: { enabled: true },
      handler: async () => {
        throw new Error("boom");
      },
    });

    const messageId = await events.publish({ id: "bad" });

    await waitFor(async () => {
      const dead = await events.deadLetters("failing");
      return dead.length === 1;
    });
    const dead = await events.deadLetters("failing");
    expect(dead[0].messageId).toBe(messageId);
    expect(dead[0].attempt).toBe(2);
  });
});

describe("PubSub adapter primitives", () => {
  it("supports memory storage atomic helpers", async () => {
    const store = new MemoryStore();

    expect(await store.saveIfAbsent!("ns", "a", { count: 1 })).toBe(true);
    expect(await store.saveIfAbsent!("ns", "a", { count: 2 })).toBe(false);
    expect(await store.increment!("ns", "counter", "offset")).toBe(1);
    expect(await store.increment!("ns", "counter", "offset", 2)).toBe(3);
    expect(
      await store.compareAndSet!("ns", "a", { count: 1 }, { count: 3 }),
    ).toBe(true);

    await store.bulkSave!("ns", [
      { id: "b", data: { offset: 2 } },
      { id: "c", data: { offset: 1 } },
    ]);
    const ordered = await store.list<{ offset: number }>("ns", undefined, {
      orderBy: { field: "offset", type: "number", direction: "asc" },
    });
    expect(
      ordered
        .map((item) => item.offset)
        .filter((offset) => offset !== undefined),
    ).toEqual([1, 2, 3]);
  });

  it("supports memory broker management helpers", async () => {
    const broker = new MemoryBroker();

    await broker.publishBatch!("broker", [{ id: "a" }, { id: "b" }]);
    expect(await broker.size!("broker")).toBe(2);
    await broker.remove!("broker", "a");
    expect(await broker.size!("broker")).toBe(1);
    await broker.pause("broker");
    expect(await broker.isPaused!("broker")).toBe(true);
  });
});
