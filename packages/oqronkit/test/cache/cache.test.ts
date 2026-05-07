import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cache,
  cacheModule,
  OqronKit,
} from "../../src/index.js";
import { resetCachesForTesting } from "../../src/cache/registry.js";
import { OqronRegistry } from "../../src/engine/index.js";

async function initCache() {
  await OqronKit.init({
    config: {
      mode: "default",
      project: "cache-test",
      environment: "test",
      modules: [cacheModule({ gcIntervalMs: 10_000 })],
      logger: false,
      triggers: false,
    },
  });
}

async function teardown() {
  try {
    await OqronKit.stop();
  } catch {
    // already stopped
  }
  OqronRegistry.getInstance()._reset();
  resetCachesForTesting();
}

describe("Cache Module", () => {
  beforeEach(() => {
    resetCachesForTesting();
    OqronRegistry.getInstance()._reset();
  });

  afterEach(teardown);

  it("registers through cacheModule and supports set/get/has/delete", async () => {
    const users = cache.create<{ id: string }>({
      name: "users-core",
      ttlMs: 60_000,
    });

    await initCache();

    await users.set("u1", { id: "u1" });
    expect(await users.has("u1")).toBe(true);
    expect(await users.get("u1")).toEqual({ id: "u1" });

    expect(await users.delete("u1")).toBe(true);
    expect(await users.get("u1")).toBeNull();
  });

  it("uses a dynamic fetcher when no global fetcher is configured", async () => {
    const c = cache.create<{ value: string }>({
      name: "dynamic-fetcher",
      ttlMs: 60_000,
    });
    const fetcher = vi.fn(async (key: string) => ({ value: key }));

    await initCache();

    await expect(c.getOrFetch("a")).rejects.toThrow(/requires a fetcher/);
    await expect(
      c.getOrFetch("a", {
        fetcher,
      }),
    ).resolves.toEqual({ value: "a" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent getOrFetch calls on the same node", async () => {
    const fetcher = vi.fn(async (key: string) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { key };
    });
    const c = cache.create<{ key: string }>({
      name: "single-flight",
      ttlMs: 60_000,
      fetcher,
    });

    await initCache();

    const results = await Promise.all(
      Array.from({ length: 100 }, () => c.getOrFetch("hot")),
    );
    expect(results.every((value) => value.key === "hot")).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("invalidates entries by tag", async () => {
    const c = cache.create<{ id: string }>({
      name: "tagged",
      ttlMs: 60_000,
    });

    await initCache();

    await c.set("a", { id: "a" }, { tags: ["group:a"] });
    await c.set("b", { id: "b" }, { tags: ["group:a"] });
    await c.set("c", { id: "c" }, { tags: ["group:b"] });

    const invalidated = await c.invalidateTags(["group:a"]);
    expect(invalidated).toBe(2);
    expect(await c.get("a")).toBeNull();
    expect(await c.get("b")).toBeNull();
    expect(await c.get("c")).toEqual({ id: "c" });
  });

  it("supports batch get/set/delete with partial-result shape", async () => {
    const c = cache.create<number>({
      name: "batch-cache",
      ttlMs: 60_000,
    });

    await initCache();

    const setResult = await c.setMany([
      { key: "a", value: 1 },
      { key: "b", value: 2 },
    ]);
    expect(setResult.ok).toBe(true);
    expect(setResult.succeeded).toEqual(["a", "b"]);
    expect(await c.getMany(["a", "b", "c"])).toEqual({
      a: 1,
      b: 2,
      c: null,
    });

    const deleteResult = await c.deleteMany(["a", "b"]);
    expect(deleteResult.ok).toBe(true);
    expect(await c.getMany(["a", "b"])).toEqual({ a: null, b: null });
  });

  it("uses fetcherMany for missing keys", async () => {
    const fetcherMany = vi.fn(async (keys: string[]) =>
      Object.fromEntries(keys.map((key) => [key, key.length])),
    );
    const c = cache.create<number>({
      name: "fetch-many",
      ttlMs: 60_000,
      fetcherMany,
    });

    await initCache();

    await c.set("a", 10);
    const result = await c.getOrFetchMany(["a", "bb", "ccc"]);
    expect(result).toEqual({ a: 10, bb: 2, ccc: 3 });
    expect(fetcherMany).toHaveBeenCalledWith(
      ["bb", "ccc"],
      expect.objectContaining({ keys: ["bb", "ccc"] }),
    );
  });
});
