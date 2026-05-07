import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { OqronContainer } from "../../src/engine/container.js";
import { initEngine, stopEngine, Storage, Broker, Lock } from "../../src/engine/core.js";
import {
  createAdapters,
  createStorageAdapter,
  createBrokerAdapter,
  createLockAdapter,
} from "../../src/engine/adapter-factory.js";

// ═══════════════════════════════════════════════════════════════════════════════
//  Adapter Factory Tests
//
//  Tests for createStorageAdapter, createBrokerAdapter, createLockAdapter,
//  createAdapters, and mode: "custom" integration with initEngine.
// ═══════════════════════════════════════════════════════════════════════════════

describe("createStorageAdapter", () => {
  it("creates a memory storage adapter", async () => {
    const storage = await createStorageAdapter({ type: "memory" });
    expect(storage).toBeDefined();
    expect(storage.save).toBeTypeOf("function");
    expect(storage.get).toBeTypeOf("function");
    expect(storage.list).toBeTypeOf("function");
    expect(storage.delete).toBeTypeOf("function");
    expect(storage.count).toBeTypeOf("function");
  });

  it("memory storage adapter performs CRUD", async () => {
    const storage = await createStorageAdapter({ type: "memory" });
    await storage.save("ns", "key1", { value: 42 });
    const result = await storage.get<{ value: number }>("ns", "key1");
    expect(result?.value).toBe(42);

    await storage.delete("ns", "key1");
    const deleted = await storage.get("ns", "key1");
    expect(deleted).toBeNull();
  });

  it("throws on unknown type", async () => {
    await expect(
      createStorageAdapter({ type: "dynamo" } as any),
    ).rejects.toThrow("Unknown storage adapter type");
  });
});

describe("createBrokerAdapter", () => {
  it("creates a memory broker adapter", async () => {
    const broker = await createBrokerAdapter({ type: "memory" });
    expect(broker).toBeDefined();
    expect(broker.publish).toBeTypeOf("function");
    expect(broker.claim).toBeTypeOf("function");
    expect(broker.ack).toBeTypeOf("function");
    expect(broker.nack).toBeTypeOf("function");
  });

  it("memory broker adapter publishes and claims", async () => {
    const broker = await createBrokerAdapter({ type: "memory" });
    await broker.publish("test-queue", "job-1");
    const claimed = await broker.claim("test-queue", "worker-1", 1, 30000);
    expect(claimed).toContain("job-1");
  });

  it("throws on unknown type", async () => {
    await expect(
      createBrokerAdapter({ type: "rabbitmq" } as any),
    ).rejects.toThrow("Unknown broker adapter type");
  });
});

describe("createLockAdapter", () => {
  it("creates a memory lock adapter", async () => {
    const lock = await createLockAdapter({ type: "memory" });
    expect(lock).toBeDefined();
    expect(lock.acquire).toBeTypeOf("function");
    expect(lock.release).toBeTypeOf("function");
    expect(lock.renew).toBeTypeOf("function");
    expect(lock.isOwner).toBeTypeOf("function");
  });

  it("memory lock adapter acquires and releases", async () => {
    const lock = await createLockAdapter({ type: "memory" });
    const acquired = await lock.acquire("my-lock", "owner-1", 5000);
    expect(acquired).toBe(true);

    const isOwner = await lock.isOwner("my-lock", "owner-1");
    expect(isOwner).toBe(true);

    await lock.release("my-lock", "owner-1");
    const afterRelease = await lock.isOwner("my-lock", "owner-1");
    expect(afterRelease).toBe(false);
  });

  it("throws on unknown type", async () => {
    await expect(
      createLockAdapter({ type: "etcd" } as any),
    ).rejects.toThrow("Unknown lock adapter type");
  });
});

describe("createAdapters (unified)", () => {
  it("creates all three adapters with mode: default", async () => {
    const adapters = await createAdapters({ mode: "default" });
    expect(adapters.storage).toBeDefined();
    expect(adapters.broker).toBeDefined();
    expect(adapters.lock).toBeDefined();
    expect(adapters.close).toBeTypeOf("function");
  });

  it("default adapters are fully functional together", async () => {
    const { storage, broker, lock, close } = await createAdapters({
      mode: "default",
    });

    // Storage works
    await storage.save("ns", "k1", { v: 1 });
    const val = await storage.get<{ v: number }>("ns", "k1");
    expect(val?.v).toBe(1);

    // Broker works
    await broker.publish("q", "j1");
    const claimed = await broker.claim("q", "w1", 1, 30000);
    expect(claimed).toContain("j1");

    // Lock works
    const locked = await lock.acquire("lk", "o1", 5000);
    expect(locked).toBe(true);

    await close();
  });

  it("custom mode passes through user adapters", async () => {
    const mockStorage = await createStorageAdapter({ type: "memory" });
    const mockBroker = await createBrokerAdapter({ type: "memory" });
    const mockLock = await createLockAdapter({ type: "memory" });

    const adapters = await createAdapters({
      mode: "custom",
      storage: mockStorage,
      broker: mockBroker,
      lock: mockLock,
    });

    expect(adapters.storage).toBe(mockStorage);
    expect(adapters.broker).toBe(mockBroker);
    expect(adapters.lock).toBe(mockLock);
  });

  it("throws on unknown mode", async () => {
    await expect(
      createAdapters({ mode: "dynamodb" } as any),
    ).rejects.toThrow("Unknown adapter mode");
  });
});

describe("initEngine — mode: custom", () => {
  afterEach(async () => {
    await stopEngine();
  });

  it("initializes with custom adapters", async () => {
    const adapters = await createAdapters({ mode: "default" });
    await initEngine({
      mode: "custom",
      adapters: {
        storage: adapters.storage,
        broker: adapters.broker,
        lock: adapters.lock,
      },
    });

    // Proxy shims should work — container is initialized
    const container = OqronContainer.get();
    expect(container).toBeDefined();
    expect(container.storage).toBeDefined();
    expect(container.broker).toBeDefined();
    expect(container.lock).toBeDefined();
  });

  it("custom adapters get environment isolation wrapping", async () => {
    const rawStorage = await createStorageAdapter({ type: "memory" });
    const rawBroker = await createBrokerAdapter({ type: "memory" });
    const rawLock = await createLockAdapter({ type: "memory" });

    await initEngine({
      mode: "custom",
      project: "myapp",
      environment: "staging",
      adapters: { storage: rawStorage, broker: rawBroker, lock: rawLock },
    });

    // Write via isolated container
    await Storage.save("jobs", "j1", { id: "j1" });

    // Direct raw storage should have the prefixed namespace
    const direct = await rawStorage.get<any>("oqron:myapp:staging:jobs", "j1");
    expect(direct?.id).toBe("j1");

    // Direct raw storage should NOT find it without prefix
    const unprefixed = await rawStorage.get("jobs", "j1");
    expect(unprefixed).toBeNull();
  });

  it("throws if mode is custom but no adapters provided", async () => {
    await expect(
      initEngine({ mode: "custom" }),
    ).rejects.toThrow('mode "custom" requires `adapters`');
  });

  it("mix-and-match: different adapter types per role", async () => {
    // Simulate: memory storage + memory broker + memory lock
    // (in production this could be PG storage + Redis broker + Redis lock)
    const storage = await createStorageAdapter({ type: "memory" });
    const broker = await createBrokerAdapter({ type: "memory" });
    const lock = await createLockAdapter({ type: "memory" });

    await initEngine({
      mode: "custom",
      adapters: { storage, broker, lock },
      project: "mixed",
      environment: "test",
    });

    // All three should work through the container
    await Storage.save("ns", "k", { data: "hello" });
    await Broker.publish("queue", "msg-1");
    const acquired = await Lock.acquire("key", "me", 5000);

    expect(await Storage.get<any>("ns", "k")).toEqual({ data: "hello" });
    expect(await Broker.claim("queue", "w", 1, 30000)).toContain("msg-1");
    expect(acquired).toBe(true);
  });
});
