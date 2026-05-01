import { afterEach, describe, expect, it } from "vitest";
import { OqronContainer } from "../../src/engine/container.js";
import { createLogger } from "../../src/engine/logger/index.js";
import { MemoryBroker } from "../../src/engine/memory/memory-broker.js";
import { MemoryLock } from "../../src/engine/memory/memory-lock.js";
import { MemoryStore } from "../../src/engine/memory/memory-store.js";
import { rateLimit } from "../../src/ratelimit/define-ratelimit.js";
import { RateLimitModule } from "../../src/ratelimit/ratelimit-module.js";

describe("RateLimitModule defaults", () => {
  afterEach(() => {
    rateLimit.destroy("module-defaulted");
    OqronContainer.reset();
  });

  it("applies module-level defaults to limiter definitions", async () => {
    const store = new MemoryStore();
    OqronContainer.init(store, new MemoryBroker(), new MemoryLock(), {
      project: "test",
      environment: "test",
    });
    rateLimit.create({
      name: "module-defaulted",
      tiers: [{ name: "t", key: () => "k", max: 1, window: "1m" }],
    });

    const mod = new RateLimitModule(
      { project: "test", environment: "test" },
      createLogger({ enabled: false }, { module: "test" }),
      {
        module: "ratelimit",
        algorithm: "fixed-window",
        failOpen: true,
        jitter: 0,
        disabledBehavior: "block",
      },
    );
    await mod.init();

    const record = await store.get<any>(
      "oqron:test:test:ratelimit_instances",
      "module-defaulted",
    );
    expect(record.algorithm).toBe("fixed-window");
    expect(record.failOpen).toBe(true);
    expect(record.disabledBehavior).toBe("block");
  });
});
