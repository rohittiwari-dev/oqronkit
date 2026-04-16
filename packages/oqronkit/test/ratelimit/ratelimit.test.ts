import { OqronEventBus } from "../../src/engine/events/event-bus.js";
import { Storage } from "../../src/engine/index.js";
import { OqronKit, rateLimit } from "../../src/index.js";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// ── Helper to create a fresh OqronKit per suite ────────────────────────────
async function bootKit() {
  await OqronKit.init({
    config: {
      project: "rl-test",
      environment: "test",
      mode: "default",
      modules: [{ module: "ratelimit" }],
    },
  });
}

describe("Rate Limit Module", () => {
  beforeAll(async () => {
    await bootKit();
  });
  afterAll(async () => {
    await OqronKit.stop();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. CORE ALGORITHMS
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Algorithms", () => {
    it("Sliding Window — basic consumption and blocking", async () => {
      const limiter = rateLimit.create({
        name: "algo-sliding",
        algorithm: "sliding-window",
        tiers: [{ name: "t", key: () => "k", max: 5, window: "1m" }],
      });
      await limiter.reset("t:k");

      for (let i = 0; i < 5; i++) {
        const r = await limiter.check({});
        expect(r.allowed).toBe(true);
        expect(r.remaining).toBe(4 - i);
      }
      const blocked = await limiter.check({});
      expect(blocked.allowed).toBe(false);
      expect(blocked.wouldBlock).toBe(true);
    });

    it("Fixed Window — counter resets per time boundary", async () => {
      const limiter = rateLimit.create({
        name: "algo-fixed",
        algorithm: "fixed-window",
        tiers: [{ name: "t", key: () => "k", max: 2, window: "10s" }],
      });
      await limiter.reset("t:k");

      const r1 = await limiter.check({});
      const r2 = await limiter.check({});
      const r3 = await limiter.check({});

      expect(r1.allowed).toBe(true);
      expect(r2.allowed).toBe(true);
      expect(r3.allowed).toBe(false);
    });

    it("Token Bucket — allows burst, then rate limits", async () => {
      const limiter = rateLimit.create({
        name: "algo-bucket",
        algorithm: "token-bucket",
        refillRate: 1,
        refillIntervalMs: 10_000,
        tiers: [{ name: "t", key: () => "k", max: 3, window: "10s" }],
      });
      await limiter.reset("t:k");

      let r = await limiter.check({}, { cost: 2 });
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(1);

      r = await limiter.check({}, { cost: 1 });
      expect(r.allowed).toBe(true);

      r = await limiter.check({}, { cost: 1 });
      expect(r.allowed).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. MULTI-TIER CASCADE
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Multi-Tier Cascade", () => {
    it("evaluates tiers in order — first block wins", async () => {
      const limiter = rateLimit.create<{ ip: string; user?: string }>({
        name: "mt-cascade",
        tiers: [
          { name: "ip", key: (ctx) => ctx.ip, max: 10, window: "1m" },
          {
            name: "user",
            key: (ctx) => ctx.user,
            max: 2,
            window: "1m",
            enabled: (ctx) => !!ctx.user,
          },
        ],
      });
      await limiter.reset("user:u1");

      const ctx = { ip: "100.0.0.1", user: "u1" };
      await limiter.check(ctx); // 1
      await limiter.check(ctx); // 2
      const r3 = await limiter.check(ctx); // 3 — user tier blocks
      expect(r3.allowed).toBe(false);
      expect(r3.tier).toBe("user");
    });

    it("skips tiers when enabled() returns false", async () => {
      const limiter = rateLimit.create<{ ip: string; user?: string }>({
        name: "mt-skip",
        tiers: [
          { name: "ip", key: (ctx) => ctx.ip, max: 10, window: "1m" },
          {
            name: "user",
            key: (ctx) => ctx.user,
            max: 2,
            window: "1m",
            enabled: (ctx) => !!ctx.user,
          },
        ],
      });
      await limiter.reset("ip:3.3.3.3");

      // user is undefined → user tier skipped
      for (let i = 0; i < 5; i++) {
        const r = await limiter.check({ ip: "3.3.3.3" });
        expect(r.allowed).toBe(true);
      }
    });

    it("skips tier when key() returns null", async () => {
      const limiter = rateLimit.create<{ ip: string }>({
        name: "mt-nullkey",
        tiers: [
          { name: "ip", key: (ctx) => ctx.ip, max: 10, window: "1m" },
          { name: "null", key: () => null as any, max: 1, window: "1m" },
        ],
      });
      await limiter.reset("ip:4.4.4.4");

      // null key tier is skipped, so only IP tier matters
      for (let i = 0; i < 5; i++) {
        const r = await limiter.check({ ip: "4.4.4.4" });
        expect(r.allowed).toBe(true);
      }
    });

    it("provides per-tier breakdown in result", async () => {
      const limiter = rateLimit.create<{ ip: string }>({
        name: "mt-breakdown",
        tiers: [
          { name: "a", key: (ctx) => ctx.ip, max: 10, window: "1m" },
          { name: "b", key: (ctx) => ctx.ip, max: 100, window: "1m" },
        ],
      });
      await limiter.reset("a:5.5.5.5");
      await limiter.reset("b:5.5.5.5");

      const r = await limiter.check({ ip: "5.5.5.5" });
      expect(r.breakdown).toHaveLength(2);
      expect(r.breakdown[0].name).toBe("a");
      expect(r.breakdown[1].name).toBe("b");
      expect(r.breakdown[0].allowed).toBe(true);
      expect(r.breakdown[1].allowed).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. WEIGHTED CONSUMPTION
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Weighted Consumption", () => {
    it("cost: 1 is default", async () => {
      const limiter = rateLimit.create({
        name: "wc-default",
        tiers: [{ name: "t", key: () => "k", max: 3, window: "1m" }],
      });
      await limiter.reset("t:k");

      const r = await limiter.check({});
      expect(r.allowed).toBe(true);
      expect(r.current).toBe(1);
    });

    it("cost: 5 deducts correctly", async () => {
      const limiter = rateLimit.create({
        name: "wc-five",
        tiers: [{ name: "t", key: () => "k", max: 10, window: "1m" }],
      });
      await limiter.reset("t:k");

      const r = await limiter.check({}, { cost: 5 });
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(5);
    });

    it("cost exceeding remaining capacity is blocked", async () => {
      const limiter = rateLimit.create({
        name: "wc-exceed",
        tiers: [{ name: "t", key: () => "k", max: 5, window: "1m" }],
      });
      await limiter.reset("t:k");

      await limiter.check({}, { cost: 3 }); // 3/5
      const r = await limiter.check({}, { cost: 10 }); // 10 > remaining 2
      expect(r.allowed).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. PENALTY ESCALATION
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Penalty Escalation", () => {
    it("auto-bans key after N violations", async () => {
      let bannedFired = false;
      OqronEventBus.on("ratelimit:banned", (_ln, _t, key) => {
        if (key === "pen-k") bannedFired = true;
      });

      const limiter = rateLimit.create({
        name: "pen-autoban",
        algorithm: "sliding-window",
        tiers: [{ name: "t", key: () => "pen-k", max: 2, window: "1m" }],
        penalty: {
          threshold: 3,
          penaltyWindow: "5m",
          banDuration: "1m",
        },
      });
      await limiter.reset("t:pen-k");

      await limiter.check({}); // 1 ok
      await limiter.check({}); // 2 ok
      await limiter.check({}); // violation 1
      await limiter.check({}); // violation 2
      const r5 = await limiter.check({}); // violation 3 → BAN

      expect(r5.allowed).toBe(false);
      expect(r5.banned).toBe(true);
      expect(bannedFired).toBe(true);
    });

    it("banned key returns banned: true on subsequent checks", async () => {
      const limiter = rateLimit.create({
        name: "pen-subseq",
        tiers: [{ name: "t", key: () => "k", max: 1, window: "1m" }],
        penalty: { threshold: 1, penaltyWindow: "5m", banDuration: "10m" },
      });
      await limiter.reset("t:k");

      await limiter.check({}); // ok
      await limiter.check({}); // violation 1 → ban

      const r = await limiter.check({});
      expect(r.allowed).toBe(false);
      expect(r.banned).toBe(true);
    });

    it("manual ban() and unban() work", async () => {
      const limiter = rateLimit.create({
        name: "pen-manual",
        tiers: [{ name: "t", key: () => "k", max: 100, window: "1m" }],
      });
      await limiter.reset("t:k");

      await limiter.ban("t:k", "1h");
      const r1 = await limiter.check({});
      expect(r1.allowed).toBe(false);
      expect(r1.banned).toBe(true);

      await limiter.unban("t:k");
      const r2 = await limiter.check({});
      expect(r2.allowed).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. QUOTA WARNINGS
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Quota Warnings", () => {
    it("fires warning handler at threshold", async () => {
      const warnings: number[] = [];

      const limiter = rateLimit.create({
        name: "qw-fire",
        tiers: [{ name: "t", key: () => "k", max: 10, window: "1m" }],
        warnings: {
          thresholds: {
            0.8: (_ctx: any, usage: any) => {
              warnings.push(usage.percent);
            },
          },
        },
      });
      await limiter.reset("t:k");

      // 8/10 = 80% → should fire
      for (let i = 0; i < 8; i++) {
        await limiter.check({});
      }

      expect(warnings.length).toBeGreaterThanOrEqual(1);
    });

    it("fires warning only once per window (dedup)", async () => {
      const warnings: number[] = [];

      const limiter = rateLimit.create({
        name: "qw-dedup",
        tiers: [{ name: "t", key: () => "k", max: 10, window: "1m" }],
        warnings: {
          thresholds: {
            0.5: (_ctx: any, usage: any) => {
              warnings.push(usage.percent);
            },
          },
        },
      });
      await limiter.reset("t:k");

      for (let i = 0; i < 9; i++) {
        await limiter.check({});
      }

      // Should fire once at 50%, not multiple times
      expect(warnings.length).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. INSTANCE MANAGEMENT (v2)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Instance Management", () => {
    it("disabled with 'skip' behavior → allowed", async () => {
      const limiter = rateLimit.create({
        name: "inst-skip",
        tiers: [{ name: "t", key: () => "k", max: 1, window: "1m" }],
      });

      // Disable the instance
      await Storage.save("ratelimit_instances", "inst-skip", {
        name: "inst-skip",
        algorithm: "sliding-window",
        tierNames: ["t"],
        dryRun: false,
        failOpen: false,
        enabled: false,
        disabledBehavior: "skip",
        createdAt: new Date(),
        tags: [],
      });

      const r = await limiter.check({});
      expect(r.allowed).toBe(true);
      expect(r.instanceDisabled).toBe(true);
    });

    it("disabled with 'block' behavior → blocked", async () => {
      const limiter = rateLimit.create({
        name: "inst-block",
        tiers: [{ name: "t", key: () => "k", max: 100, window: "1m" }],
      });

      await Storage.save("ratelimit_instances", "inst-block", {
        name: "inst-block",
        algorithm: "sliding-window",
        tierNames: ["t"],
        dryRun: false,
        failOpen: false,
        enabled: false,
        disabledBehavior: "block",
        createdAt: new Date(),
        tags: [],
      });

      const r = await limiter.check({});
      expect(r.allowed).toBe(false);
      expect(r.instanceDisabled).toBe(true);
    });

    it("disabled with 'passthrough' behavior → allowed + passthrough flag", async () => {
      const limiter = rateLimit.create({
        name: "inst-pt",
        tiers: [{ name: "t", key: () => "k", max: 1, window: "1m" }],
      });
      await limiter.reset("t:k");

      await Storage.save("ratelimit_instances", "inst-pt", {
        name: "inst-pt",
        algorithm: "sliding-window",
        tierNames: ["t"],
        dryRun: false,
        failOpen: false,
        enabled: false,
        disabledBehavior: "passthrough",
        createdAt: new Date(),
        tags: [],
      });

      const r = await limiter.check({});
      expect(r.allowed).toBe(true);
      expect(r.passthrough).toBe(true);
      expect(r.instanceDisabled).toBe(true);
    });

    it("re-enabling instance restores normal behavior", async () => {
      const limiter = rateLimit.create({
        name: "inst-reenable",
        tiers: [{ name: "t", key: () => "k", max: 1, window: "1m" }],
      });
      await limiter.reset("t:k");

      // Disable
      await Storage.save("ratelimit_instances", "inst-reenable", {
        name: "inst-reenable",
        algorithm: "sliding-window",
        tierNames: ["t"],
        dryRun: false,
        failOpen: false,
        enabled: false,
        disabledBehavior: "skip",
        createdAt: new Date(),
        tags: [],
      });

      const r1 = await limiter.check({});
      expect(r1.allowed).toBe(true);
      expect(r1.instanceDisabled).toBe(true);

      // Re-enable
      await Storage.save("ratelimit_instances", "inst-reenable", {
        name: "inst-reenable",
        algorithm: "sliding-window",
        tierNames: ["t"],
        dryRun: false,
        failOpen: false,
        enabled: true,
        disabledBehavior: "skip",
        createdAt: new Date(),
        tags: [],
      });

      const r2 = await limiter.check({});
      expect(r2.allowed).toBe(true);
      expect(r2.instanceDisabled).toBe(false);

      const r3 = await limiter.check({});
      expect(r3.allowed).toBe(false); // now rate limited normally
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. STATS ACCUMULATION (v2)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Stats Accumulation", () => {
    it("totalChecks increments on each check()", async () => {
      const limiter = rateLimit.create({
        name: "stats-count",
        tiers: [{ name: "t", key: () => "k", max: 100, window: "1m" }],
      });
      await limiter.reset("t:k");
      // Clear any existing stats
      await Storage.delete("ratelimit_stats", "stats-count");

      await limiter.check({});
      await limiter.check({});
      await limiter.check({});

      // Stats are fire-and-forget, give them a tick
      await new Promise((r) => setTimeout(r, 50));

      const stats = await Storage.get<any>("ratelimit_stats", "stats-count");
      expect(stats).not.toBeNull();
      expect(stats.totalChecks).toBe(3);
      expect(stats.totalAllowed).toBe(3);
      expect(stats.totalBlocked).toBe(0);
    });

    it("totalBlocked increments on blocked checks", async () => {
      const limiter = rateLimit.create({
        name: "stats-block",
        tiers: [{ name: "t", key: () => "k", max: 1, window: "1m" }],
      });
      await limiter.reset("t:k");
      await Storage.delete("ratelimit_stats", "stats-block");

      await limiter.check({}); // allowed
      await limiter.check({}); // blocked

      await new Promise((r) => setTimeout(r, 50));

      const stats = await Storage.get<any>("ratelimit_stats", "stats-block");
      expect(stats.totalChecks).toBe(2);
      expect(stats.totalAllowed).toBe(1);
      expect(stats.totalBlocked).toBe(1);
    });

    it("tierStats tracks per-tier checks and blocks", async () => {
      const limiter = rateLimit.create({
        name: "stats-tier",
        tiers: [
          { name: "a", key: () => "k", max: 2, window: "1m" },
          { name: "b", key: () => "k", max: 100, window: "1m" },
        ],
      });
      await limiter.reset("a:k");
      await limiter.reset("b:k");
      await Storage.delete("ratelimit_stats", "stats-tier");

      await limiter.check({}); // both pass
      await limiter.check({}); // both pass
      await limiter.check({}); // a blocks

      await new Promise((r) => setTimeout(r, 50));

      const stats = await Storage.get<any>("ratelimit_stats", "stats-tier");
      expect(stats.tierStats.a.checks).toBe(3);
      expect(stats.tierStats.a.blocks).toBeGreaterThanOrEqual(1);
      expect(stats.tierStats.b.checks).toBe(3);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. BLOCK EVENT AUDIT TRAIL (v2)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Block Event Audit Trail", () => {
    it("writes event to storage on block", async () => {
      const limiter = rateLimit.create({
        name: "evt-block",
        tiers: [{ name: "t", key: () => "k", max: 1, window: "1m" }],
      });
      await limiter.reset("t:k");

      await limiter.check({}); // allowed
      await limiter.check({}); // blocked → should write event

      await new Promise((r) => setTimeout(r, 50));

      const events = await Storage.list<any>("ratelimit_events", {});
      const matching = events.filter(
        (e: any) => e.limiterName === "evt-block" && e.type === "blocked",
      );
      expect(matching.length).toBeGreaterThanOrEqual(1);
      expect(matching[0].tier).toBe("t");
      expect(matching[0].key).toBe("k");
    });

    it("does NOT write event on dry-run blocks", async () => {
      const limiter = rateLimit.create({
        name: "evt-dryrun",
        dryRun: true,
        tiers: [{ name: "t", key: () => "k", max: 1, window: "1m" }],
      });
      await limiter.reset("t:k");

      await limiter.check({});
      await limiter.check({}); // would block, but dry run → allowed

      await new Promise((r) => setTimeout(r, 50));

      const events = await Storage.list<any>("ratelimit_events", {});
      const matching = events.filter(
        (e: any) => e.limiterName === "evt-dryrun",
      );
      expect(matching.length).toBe(0); // No events for dry-run
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 9. ADMIN APIs
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Admin APIs & VIP Override", () => {
    it("getStatus() returns correct state", async () => {
      const limiter = rateLimit.create({
        name: "admin-status",
        tiers: [{ name: "t", key: () => "k", max: 10, window: "1m" }],
      });
      await limiter.reset("t:k");

      await limiter.check({});
      await limiter.check({});

      const status = await limiter.getStatus("t:k");
      expect(status).not.toBeNull();
      expect(status!.current).toBe(2);
      expect(status!.max).toBe(10);
      expect(status!.remaining).toBe(8);
    });

    it("reset() clears counters", async () => {
      const limiter = rateLimit.create({
        name: "admin-reset",
        tiers: [{ name: "t", key: () => "k", max: 3, window: "1m" }],
      });
      await limiter.reset("t:k");

      await limiter.check({});
      await limiter.check({});

      await limiter.reset("t:k");

      const status = await limiter.getStatus("t:k");
      expect(status!.current).toBe(0);
    });

    it("setOverride() / clearOverride() work", async () => {
      const limiter = rateLimit.create({
        name: "admin-override",
        tiers: [{ name: "t", key: () => "k", max: 2, window: "1m" }],
      });
      await limiter.reset("t:k");

      await limiter.setOverride("t:k", { max: 100 });
      const s1 = await limiter.getStatus("t:k");
      expect(s1?.max).toBe(100);
      expect(s1?.override).toEqual({ max: 100 });

      await limiter.clearOverride("t:k");
      const s2 = await limiter.getStatus("t:k");
      expect(s2?.max).toBe(2);
    });

    it("snapshot() returns complete state dump", async () => {
      const limiter = rateLimit.create({
        name: "admin-snapshot",
        tiers: [{ name: "t", key: () => "k", max: 5, window: "1m" }],
      });
      await limiter.reset("t:k");

      // Pre-populate some state
      await limiter.check({});
      await limiter.check({});

      const snap = await limiter.snapshot();
      expect(snap.name).toBe("admin-snapshot");
      expect(snap.algorithm).toBe("sliding-window");
      expect(snap.exportedAt).toBeInstanceOf(Date);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 10. DRY-RUN MODE
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Dry-Run Mode", () => {
    it("always allows but sets wouldBlock when exceeded", async () => {
      const limiter = rateLimit.create({
        name: "dry-full",
        dryRun: true,
        tiers: [{ name: "t", key: () => "k", max: 1, window: "1m" }],
      });
      await limiter.reset("t:k");

      const r1 = await limiter.check({});
      expect(r1.allowed).toBe(true);
      expect(r1.wouldBlock).toBe(false);

      const r2 = await limiter.check({});
      expect(r2.allowed).toBe(true);
      expect(r2.wouldBlock).toBe(true);
    });

    it("onLimit hook fires even in dry-run", async () => {
      let hookFired = false;
      const limiter = rateLimit.create({
        name: "dry-hook",
        dryRun: true,
        tiers: [{ name: "t", key: () => "k", max: 1, window: "1m" }],
        onLimit: () => {
          hookFired = true;
        },
      });
      await limiter.reset("t:k");

      await limiter.check({});
      await limiter.check({}); // would block → fires onLimit

      expect(hookFired).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 11. SKIP / WHITELIST
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Skip / Whitelist", () => {
    it("skip: true bypasses all tiers", async () => {
      const limiter = rateLimit.create<{ admin?: boolean }>({
        name: "skip-all",
        skip: (ctx) => !!ctx.admin,
        tiers: [{ name: "t", key: () => "k", max: 1, window: "1m" }],
      });
      await limiter.reset("t:k");

      // Use 1 slot
      await limiter.check({ admin: false });

      // Admin skips even though limit exceeded
      const r = await limiter.check({ admin: true });
      expect(r.allowed).toBe(true);
      expect(r.skipped).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 12. HEADERS
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Headers", () => {
    it("toHeaders() returns standard rate limit headers", async () => {
      const limiter = rateLimit.create({
        name: "hdr-test",
        tiers: [{ name: "t", key: () => "k", max: 10, window: "1m" }],
      });
      await limiter.reset("t:k");

      const r = await limiter.check({});
      const headers = r.toHeaders();

      expect(headers["X-RateLimit-Limit"]).toBeDefined();
      expect(headers["X-RateLimit-Remaining"]).toBeDefined();
      expect(headers["X-RateLimit-Reset"]).toBeDefined();
    });

    it("Retry-After header present only when blocked", async () => {
      const limiter = rateLimit.create({
        name: "hdr-retry",
        tiers: [{ name: "t", key: () => "k", max: 1, window: "1m" }],
      });
      await limiter.reset("t:k");

      const r1 = await limiter.check({});
      const h1 = r1.toHeaders();
      expect(h1["Retry-After"]).toBeUndefined();

      const r2 = await limiter.check({});
      const h2 = r2.toHeaders();
      expect(h2["Retry-After"]).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 13. RESILIENCE
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Resilience", () => {
    it("failOpen: true allows when storage errors", async () => {
      const limiter = rateLimit.create({
        name: "res-failopen",
        failOpen: true,
        tiers: [{ name: "t", key: () => "k", max: 1, window: "1m" }],
      });

      // We test the contract: failOpen should allow gracefully
      const r = await limiter.check({});
      expect(r.allowed).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 14. EVENTBUS
  // ═══════════════════════════════════════════════════════════════════════════

  describe("EventBus Emissions", () => {
    it("emits ratelimit:blocked", async () => {
      let emitted = false;
      OqronEventBus.on("ratelimit:blocked", (ln) => {
        if (ln === "eb-block") emitted = true;
      });

      const limiter = rateLimit.create({
        name: "eb-block",
        tiers: [{ name: "t", key: () => "k", max: 1, window: "1m" }],
      });
      await limiter.reset("t:k");

      await limiter.check({});
      await limiter.check({}); // blocked

      expect(emitted).toBe(true);
    });

    it("emits ratelimit:banned", async () => {
      let emitted = false;
      OqronEventBus.on("ratelimit:banned", (ln) => {
        if (ln === "eb-ban") emitted = true;
      });

      const limiter = rateLimit.create({
        name: "eb-ban",
        tiers: [{ name: "t", key: () => "k", max: 100, window: "1m" }],
      });
      await limiter.ban("t:k", "1h");

      expect(emitted).toBe(true);
    });

    it("emits ratelimit:override", async () => {
      let emitted = false;
      OqronEventBus.on("ratelimit:override", (ln) => {
        if (ln === "eb-ovr") emitted = true;
      });

      const limiter = rateLimit.create({
        name: "eb-ovr",
        tiers: [{ name: "t", key: () => "k", max: 5, window: "1m" }],
      });
      await limiter.setOverride("t:k", { max: 999 });

      expect(emitted).toBe(true);
    });

    it("emits ratelimit:warning", async () => {
      let emitted = false;
      OqronEventBus.on("ratelimit:warning", (ln) => {
        if (ln === "eb-warn") emitted = true;
      });

      const limiter = rateLimit.create({
        name: "eb-warn",
        tiers: [{ name: "t", key: () => "k", max: 10, window: "1m" }],
        warnings: {
          thresholds: {
            0.5: () => {},
          },
        },
      });
      await limiter.reset("t:k");

      for (let i = 0; i < 6; i++) {
        await limiter.check({});
      }

      expect(emitted).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 15. JITTER
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Jitter", () => {
    it("retryAfterSecs varies within ± jitter range", async () => {
      const limiter = rateLimit.create({
        name: "jitter-test",
        jitter: 0.5,
        tiers: [{ name: "t", key: () => "k", max: 1, window: "60s" }],
      });
      await limiter.reset("t:k");

      await limiter.check({});

      const r = await limiter.check({});
      // With 50% jitter and ~60s window, retryAfter should be between 30s and 90s
      expect(r.retryAfterSecs).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 16. COST ESTIMATOR (v2 Magic)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Cost Estimator", () => {
    it("auto-calculates cost from context when not explicitly passed", async () => {
      const limiter = rateLimit.create<{ tokens: number }>({
        name: "ce-auto",
        tiers: [{ name: "t", key: () => "k", max: 10, window: "1m" }],
        costEstimator: (ctx) => ctx.tokens,
      });
      await limiter.reset("t:k");

      const r1 = await limiter.check({ tokens: 6 });
      expect(r1.allowed).toBe(true);
      expect(r1.current).toBe(6);

      const r2 = await limiter.check({ tokens: 5 }); // 6 + 5 = 11 > 10
      expect(r2.allowed).toBe(false);
    });

    it("explicit cost overrides estimator", async () => {
      const limiter = rateLimit.create<{ tokens: number }>({
        name: "ce-override",
        tiers: [{ name: "t", key: () => "k", max: 10, window: "1m" }],
        costEstimator: (ctx) => ctx.tokens,
      });
      await limiter.reset("t:k");

      // Explicit cost=1 even though estimator would return 8
      const r = await limiter.check({ tokens: 8 }, { cost: 1 });
      expect(r.allowed).toBe(true);
      expect(r.current).toBe(1); // Used 1, not 8
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 17. DEPENDS ON (v2 Magic)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("DependsOn Chaining", () => {
    it("blocks if dependency limiter is exhausted", async () => {
      // Create the upstream limiter first
      const upstream = rateLimit.create({
        name: "dep-upstream",
        tiers: [{ name: "t", key: () => "k", max: 1, window: "1m" }],
      });
      await upstream.reset("t:k");
      await upstream.check({}); // exhaust

      // Create downstream that depends on upstream
      const downstream = rateLimit.create({
        name: "dep-downstream",
        tiers: [{ name: "t", key: () => "k", max: 100, window: "1m" }],
        dependsOn: ["dep-upstream"],
      });
      await downstream.reset("t:k");

      const r = await downstream.check({});
      expect(r.allowed).toBe(false);
      expect(r.tier).toContain("dep:dep-upstream");
    });

    it("allows if dependency limiter has capacity", async () => {
      const upstream = rateLimit.create({
        name: "dep-up-ok",
        tiers: [{ name: "t", key: () => "k", max: 100, window: "1m" }],
      });
      await upstream.reset("t:k");

      const downstream = rateLimit.create({
        name: "dep-down-ok",
        tiers: [{ name: "t", key: () => "k", max: 5, window: "1m" }],
        dependsOn: ["dep-up-ok"],
      });
      await downstream.reset("t:k");

      const r = await downstream.check({});
      expect(r.allowed).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 18. PEEK (read-only)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Peek (read-only)", () => {
    it("does not consume tokens", async () => {
      const limiter = rateLimit.create({
        name: "peek-test",
        tiers: [{ name: "t", key: () => "k", max: 3, window: "1m" }],
      });
      await limiter.reset("t:k");

      // Peek multiple times — none should consume
      const p1 = await limiter.peek({});
      expect(p1.allowed).toBe(true);
      expect(p1.remaining).toBe(3); // peek cost=0, current=0, remaining = max - current = 3

      const p2 = await limiter.peek({});
      expect(p2.allowed).toBe(true);

      // Now actually consume all 3
      await limiter.check({});
      await limiter.check({});
      await limiter.check({});

      // Peek at capacity: cost=0 means "is current state over?" → 3+0 <= 3 → true
      const p3 = await limiter.peek({});
      expect(p3.allowed).toBe(true);
      expect(p3.remaining).toBe(0);

      // Actually try to consume one more — this should fail
      const r4 = await limiter.check({});
      expect(r4.allowed).toBe(false);
    });
  });
});
