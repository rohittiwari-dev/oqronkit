import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { OqronContainer } from "../../src/engine/container.js";
import { MemoryStore } from "../../src/engine/memory/memory-store.js";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";
import { MemoryLock } from "../../src/engine/memory/memory-lock.js";
import { initEngine, stopEngine, Storage, Broker, Lock } from "../../src/engine/core.js";

describe("OqronContainer — Lifecycle", () => {
  afterEach(() => {
    OqronContainer.reset();
  });

  it("init() creates the singleton", () => {
    const store = new MemoryStore();
    const broker = new MemoryBroker();
    const lock = new MemoryLock();

    const container = OqronContainer.init(store, broker, lock);
    expect(container.storage).toBe(store);
    expect(container.broker).toBe(broker);
    expect(container.lock).toBe(lock);
  });

  it("get() returns the singleton after init", () => {
    OqronContainer.init(new MemoryStore(), new MemoryBroker(), new MemoryLock());
    const c = OqronContainer.get();
    expect(c).toBeDefined();
    expect(c.storage).toBeDefined();
  });

  it("get() throws before init", () => {
    expect(() => OqronContainer.get()).toThrow("Container not initialized");
  });

  it("tryGet() returns null before init", () => {
    expect(OqronContainer.tryGet()).toBeNull();
  });

  it("tryGet() returns the container after init", () => {
    OqronContainer.init(new MemoryStore(), new MemoryBroker(), new MemoryLock());
    expect(OqronContainer.tryGet()).toBeDefined();
  });

  it("reset() clears the singleton", () => {
    OqronContainer.init(new MemoryStore(), new MemoryBroker(), new MemoryLock());
    OqronContainer.reset();
    expect(OqronContainer.tryGet()).toBeNull();
    expect(() => OqronContainer.get()).toThrow();
  });

  it("re-init replaces the previous container", () => {
    const store1 = new MemoryStore();
    const store2 = new MemoryStore();

    OqronContainer.init(store1, new MemoryBroker(), new MemoryLock());
    expect(OqronContainer.get().storage).toBe(store1);

    OqronContainer.init(store2, new MemoryBroker(), new MemoryLock());
    expect(OqronContainer.get().storage).toBe(store2);
  });
});

describe("OqronContainer — Multi-Instance Isolation", () => {
  afterEach(() => {
    OqronContainer.reset();
  });

  it("two container instances are independent", () => {
    const c1 = new OqronContainer(
      new MemoryStore(),
      new MemoryBroker(),
      new MemoryLock(),
    );
    const c2 = new OqronContainer(
      new MemoryStore(),
      new MemoryBroker(),
      new MemoryLock(),
    );

    expect(c1.storage).not.toBe(c2.storage);
    expect(c1.broker).not.toBe(c2.broker);
    expect(c1.lock).not.toBe(c2.lock);
  });

  it("instance adapters are writable through the constructor", async () => {
    const store = new MemoryStore();
    const c = new OqronContainer(store, new MemoryBroker(), new MemoryLock());

    await c.storage.save("ns", "k", { v: 1 });
    const val = await store.get<{ v: number }>("ns", "k");
    expect(val?.v).toBe(1);
  });
});

describe("Backward-Compatible Proxy Shims", () => {
  beforeEach(async () => {
    await initEngine({ project: "proxy-test", environment: "test" });
  });

  afterEach(async () => {
    await stopEngine();
  });

  it("Storage proxy delegates to container", async () => {
    await Storage.save("ns", "proxy-key", { x: 42 });
    const val = await Storage.get<{ x: number }>("ns", "proxy-key");
    expect(val?.x).toBe(42);
  });

  it("Broker proxy delegates to container", async () => {
    await Broker.publish("q", "id-1");
    const claimed = await Broker.claim("q", "w1", 1, 30000);
    expect(claimed).toContain("id-1");
  });

  it("Lock proxy delegates to container", async () => {
    const ok = await Lock.acquire("k", "owner", 5000);
    expect(ok).toBe(true);
    expect(await Lock.isOwner("k", "owner")).toBe(true);
  });

  it("Storage.count works through proxy", async () => {
    await Storage.save("ns", "a", { v: 1 });
    await Storage.save("ns", "b", { v: 2 });
    expect(await Storage.count("ns")).toBe(2);
  });

  it("initEngine creates a new container each time", async () => {
    await Storage.save("ns", "before", { v: 1 });
    await stopEngine();

    await initEngine({ project: "fresh", environment: "test" });
    const val = await Storage.get("ns", "before");
    expect(val).toBeNull(); // Fresh MemoryStore = no data
  });
});
