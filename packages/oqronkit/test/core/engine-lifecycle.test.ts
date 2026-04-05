import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initEngine, stopEngine, Storage, Broker, Lock } from "../../src/engine/core.js";
import { OqronRegistry } from "../../src/engine/registry.js";
import { MemoryStore } from "../../src/engine/memory/memory-store.js";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";
import { MemoryLock } from "../../src/engine/memory/memory-lock.js";
import type { OqronConfig } from "../../src/engine/types/config.types.js";

describe("Core Engine — initEngine / stopEngine lifecycle", () => {
  afterEach(async () => {
    await stopEngine();
  });

  it("initializes memory adapters by default (no redis/postgres)", async () => {
    await initEngine({ project: "test", environment: "test" });

    expect(Storage).toBeDefined();
    expect(Broker).toBeDefined();
    expect(Lock).toBeDefined();
  });

  it("Storage, Broker, Lock are functional after init", async () => {
    await initEngine({ project: "test", environment: "test" });

    await Storage.save("test-ns", "key1", { v: 1 });
    const val = await Storage.get<{ v: number }>("test-ns", "key1");
    expect(val?.v).toBe(1);

    await Broker.publish("test-q", "id-1");
    const claimed = await Broker.claim("test-q", "w1", 1, 30000);
    expect(claimed).toContain("id-1");

    const locked = await Lock.acquire("test-k", "owner1", 5000);
    expect(locked).toBe(true);
  });

  it("stopEngine does not throw when called without init", async () => {
    await expect(stopEngine()).resolves.toBeUndefined();
  });

  it("stopEngine can be called multiple times safely", async () => {
    await initEngine({ project: "test", environment: "test" });
    await stopEngine();
    await expect(stopEngine()).resolves.toBeUndefined();
  });

  it("re-init after stop creates fresh adapters", async () => {
    await initEngine({ project: "test", environment: "test" });
    await Storage.save("ns", "k", { before: true });
    await stopEngine();

    await initEngine({ project: "test2", environment: "test" });
    const val = await Storage.get("ns", "k");
    // Fresh MemoryStore = no data
    expect(val).toBeNull();
  });
});

describe("OqronRegistry", () => {
  beforeEach(() => {
    OqronRegistry.getInstance()._reset();
  });

  it("is a singleton", () => {
    const a = OqronRegistry.getInstance();
    const b = OqronRegistry.getInstance();
    expect(a).toBe(b);
  });

  it("registers and retrieves a module", () => {
    const mod = {
      name: "test-mod",
      enabled: true,
      init: async () => {},
      start: async () => {},
      stop: async () => {},
      triggerManual: async () => false,
    };
    OqronRegistry.getInstance().register(mod);
    expect(OqronRegistry.getInstance().get("test-mod")).toBe(mod);
  });

  it("getAll returns all registered modules", () => {
    const mod1 = { name: "m1", enabled: true, init: async () => {}, start: async () => {}, stop: async () => {}, triggerManual: async () => false };
    const mod2 = { name: "m2", enabled: false, init: async () => {}, start: async () => {}, stop: async () => {}, triggerManual: async () => false };
    OqronRegistry.getInstance().register(mod1);
    OqronRegistry.getInstance().register(mod2);

    const all = OqronRegistry.getInstance().getAll();
    expect(all).toHaveLength(2);
    expect(all.map((m) => m.name).sort()).toEqual(["m1", "m2"]);
  });

  it("throws when registering a duplicate module name", () => {
    const mod = { name: "dup", enabled: true, init: async () => {}, start: async () => {}, stop: async () => {}, triggerManual: async () => false };
    OqronRegistry.getInstance().register(mod);
    expect(() => OqronRegistry.getInstance().register(mod)).toThrow(/already registered/);
  });

  it("get returns undefined for unknown module", () => {
    expect(OqronRegistry.getInstance().get("nope")).toBeUndefined();
  });

  it("_reset clears all modules", () => {
    const mod = { name: "r", enabled: true, init: async () => {}, start: async () => {}, stop: async () => {}, triggerManual: async () => false };
    OqronRegistry.getInstance().register(mod);
    OqronRegistry.getInstance()._reset();
    expect(OqronRegistry.getInstance().getAll()).toHaveLength(0);
  });
});
