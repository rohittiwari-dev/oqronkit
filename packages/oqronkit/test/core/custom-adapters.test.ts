import { describe, expect, it, vi } from "vitest";
import {
  createStorage,
  createBroker,
  createLock,
} from "../../src/engine/adapter-factory.js";

// ── createStorage ───────────────────────────────────────────────────────────

describe("createStorage", () => {
  const validImpl = {
    save: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    prune: vi.fn().mockResolvedValue(0),
    count: vi.fn().mockResolvedValue(0),
  };

  it("should return a valid IStorageEngine from a plain object", () => {
    const storage = createStorage({ ...validImpl });
    expect(storage.save).toBeDefined();
    expect(storage.get).toBeDefined();
    expect(storage.list).toBeDefined();
    expect(storage.delete).toBeDefined();
    expect(storage.prune).toBeDefined();
    expect(storage.count).toBeDefined();
  });

  it("should delegate calls to the provided implementation", async () => {
    const impl = {
      save: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue({ id: "1", data: "hello" }),
      list: vi.fn().mockResolvedValue([{ id: "1" }]),
      delete: vi.fn().mockResolvedValue(undefined),
      prune: vi.fn().mockResolvedValue(3),
      count: vi.fn().mockResolvedValue(42),
    };

    const storage = createStorage(impl);

    await storage.save("jobs", "j1", { data: "test" });
    expect(impl.save).toHaveBeenCalledWith("jobs", "j1", { data: "test" });

    const result = await storage.get("jobs", "j1");
    expect(result).toEqual({ id: "1", data: "hello" });
    expect(impl.get).toHaveBeenCalledWith("jobs", "j1");

    const list = await storage.list("jobs", { status: "active" });
    expect(list).toEqual([{ id: "1" }]);

    await storage.delete("jobs", "j1");
    expect(impl.delete).toHaveBeenCalledWith("jobs", "j1");

    const pruned = await storage.prune("jobs", 1000);
    expect(pruned).toBe(3);

    const count = await storage.count("jobs", { status: "waiting" });
    expect(count).toBe(42);
  });

  it("should throw if any required method is missing", () => {
    const { save, ...missing } = validImpl;
    expect(() => createStorage(missing as any)).toThrow(/createStorage/);
  });

  it("should throw if get is missing", () => {
    const { get, ...missing } = validImpl;
    expect(() => createStorage(missing as any)).toThrow(/createStorage/);
  });

  it("should throw if list is missing", () => {
    const { list, ...missing } = validImpl;
    expect(() => createStorage(missing as any)).toThrow(/createStorage/);
  });
});

// ── createBroker ────────────────────────────────────────────────────────────

describe("createBroker", () => {
  const validImpl = {
    publish: vi.fn().mockResolvedValue(undefined),
    claim: vi.fn().mockResolvedValue([]),
    extendLock: vi.fn().mockResolvedValue(undefined),
    ack: vi.fn().mockResolvedValue(undefined),
    nack: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
  };

  it("should return a valid IBrokerEngine from a plain object", () => {
    const broker = createBroker({ ...validImpl });
    expect(broker.publish).toBeDefined();
    expect(broker.claim).toBeDefined();
    expect(broker.extendLock).toBeDefined();
    expect(broker.ack).toBeDefined();
    expect(broker.nack).toBeDefined();
    expect(broker.pause).toBeDefined();
    expect(broker.resume).toBeDefined();
  });

  it("should delegate calls to the provided implementation", async () => {
    const impl = {
      publish: vi.fn().mockResolvedValue(undefined),
      claim: vi.fn().mockResolvedValue(["job-1", "job-2"]),
      extendLock: vi.fn().mockResolvedValue(undefined),
      ack: vi.fn().mockResolvedValue(undefined),
      nack: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn().mockResolvedValue(undefined),
      resume: vi.fn().mockResolvedValue(undefined),
    };

    const broker = createBroker(impl);

    await broker.publish("my-queue", "job-1", 5000, 1);
    expect(impl.publish).toHaveBeenCalledWith("my-queue", "job-1", 5000, 1);

    const claimed = await broker.claim("my-queue", "worker-1", 5, 30000);
    expect(claimed).toEqual(["job-1", "job-2"]);

    await broker.ack("my-queue", "job-1");
    expect(impl.ack).toHaveBeenCalledWith("my-queue", "job-1");

    await broker.nack("my-queue", "job-2", 1000);
    expect(impl.nack).toHaveBeenCalledWith("my-queue", "job-2", 1000);

    await broker.pause("my-queue");
    expect(impl.pause).toHaveBeenCalledWith("my-queue");

    await broker.resume("my-queue");
    expect(impl.resume).toHaveBeenCalledWith("my-queue");
  });

  it("should accept optional claimBlocking method", () => {
    const broker = createBroker({
      ...validImpl,
      claimBlocking: vi.fn().mockResolvedValue("job-1"),
    });
    expect(broker.claimBlocking).toBeDefined();
  });

  it("should throw if any required method is missing", () => {
    const { publish, ...missing } = validImpl;
    expect(() => createBroker(missing as any)).toThrow(/createBroker/);
  });

  it("should throw if ack is missing", () => {
    const { ack, ...missing } = validImpl;
    expect(() => createBroker(missing as any)).toThrow(/createBroker/);
  });
});

// ── createLock ──────────────────────────────────────────────────────────────

describe("createLock", () => {
  const validImpl = {
    acquire: vi.fn().mockResolvedValue(true),
    renew: vi.fn().mockResolvedValue(true),
    release: vi.fn().mockResolvedValue(undefined),
    isOwner: vi.fn().mockResolvedValue(true),
  };

  it("should return a valid ILockAdapter from a plain object", () => {
    const lock = createLock({ ...validImpl });
    expect(lock.acquire).toBeDefined();
    expect(lock.renew).toBeDefined();
    expect(lock.release).toBeDefined();
    expect(lock.isOwner).toBeDefined();
  });

  it("should delegate calls to the provided implementation", async () => {
    const impl = {
      acquire: vi.fn().mockResolvedValue(true),
      renew: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
      isOwner: vi.fn().mockResolvedValue(false),
    };

    const lock = createLock(impl);

    const acquired = await lock.acquire("leader-lock", "node-1", 15000);
    expect(acquired).toBe(true);
    expect(impl.acquire).toHaveBeenCalledWith("leader-lock", "node-1", 15000);

    const renewed = await lock.renew("leader-lock", "node-1", 15000);
    expect(renewed).toBe(true);

    await lock.release("leader-lock", "node-1");
    expect(impl.release).toHaveBeenCalledWith("leader-lock", "node-1");

    const owned = await lock.isOwner("leader-lock", "node-2");
    expect(owned).toBe(false);
    expect(impl.isOwner).toHaveBeenCalledWith("leader-lock", "node-2");
  });

  it("should throw if any required method is missing", () => {
    const { acquire, ...missing } = validImpl;
    expect(() => createLock(missing as any)).toThrow(/createLock/);
  });

  it("should throw if release is missing", () => {
    const { release, ...missing } = validImpl;
    expect(() => createLock(missing as any)).toThrow(/createLock/);
  });

  it("should throw if isOwner is missing", () => {
    const { isOwner, ...missing } = validImpl;
    expect(() => createLock(missing as any)).toThrow(/createLock/);
  });
});

// ── Integration: custom adapters work with OqronKit ─────────────────────────

describe("Custom Adapters Integration", () => {
  it("should create all three adapters and use them together", async () => {
    const storage = createStorage({
      save: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
      prune: vi.fn().mockResolvedValue(0),
      count: vi.fn().mockResolvedValue(0),
    });

    const broker = createBroker({
      publish: vi.fn().mockResolvedValue(undefined),
      claim: vi.fn().mockResolvedValue([]),
      extendLock: vi.fn().mockResolvedValue(undefined),
      ack: vi.fn().mockResolvedValue(undefined),
      nack: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn().mockResolvedValue(undefined),
      resume: vi.fn().mockResolvedValue(undefined),
    });

    const lock = createLock({
      acquire: vi.fn().mockResolvedValue(true),
      renew: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
      isOwner: vi.fn().mockResolvedValue(true),
    });

    // All adapters are properly typed and functional
    await storage.save("ns", "id", { test: true });
    await broker.publish("q", "j1");
    const acquired = await lock.acquire("key", "owner", 5000);

    expect(storage.save).toHaveBeenCalled();
    expect(broker.publish).toHaveBeenCalled();
    expect(acquired).toBe(true);
  });
});
