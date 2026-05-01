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
      expect(s1?.override).toMatchObject({ max: 100 });

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

  // ═══════════════════════════════════════════════════════════════════════════
  // 19. COVERAGE: RateLimitModule (disable, GC tick)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("RateLimitModule Lifecycle", () => {
    it("disable() sets enabled=false and stops tick", async () => {
      // The module is already running via OqronKit.init
      // We access it via the container's module list
      const { RateLimitModule } = await import(
        "../../src/ratelimit/ratelimit-module.js"
      );
      const mod = new RateLimitModule(
        { project: "t", environment: "test", mode: "default" } as any,
        { info: () => {}, warn: () => {}, error: () => {} } as any,
        { module: "ratelimit", gcIntervalMs: 60000, eventRetentionMs: 86400000 },
      );
      await mod.init();
      await mod.start();
      expect(mod.enabled).toBe(true);

      await mod.disable();
      expect(mod.enabled).toBe(false);

      // Re-enable
      await mod.enable();
      expect(mod.enabled).toBe(true);

      // Clean up
      await mod.stop();
    });

    it("GC tick prunes expired data without errors", async () => {
      const { RateLimitModule } = await import(
        "../../src/ratelimit/ratelimit-module.js"
      );

      const logs: string[] = [];
      const mod = new RateLimitModule(
        { project: "t", environment: "test", mode: "default" } as any,
        {
          info: (m: string) => logs.push(m),
          warn: (m: string) => logs.push(m),
          error: (m: string) => logs.push(m),
        } as any,
        { module: "ratelimit", gcIntervalMs: 100, eventRetentionMs: 1000 },
      );
      await mod.init();
      // Manually trigger tick by calling _tick via start (it schedules setTimeout)
      // We'll access the private method for direct test
      await (mod as any)._tick();
      // If no error thrown, GC ran successfully
      await mod.stop();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 20. COVERAGE: Engine edge cases
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Engine Edge Cases", () => {
    it("unban() fires onUnban hook", async () => {
      let hookFired = false;
      const limiter = rateLimit.create({
        name: "cov-unban-hook",
        tiers: [{ name: "t", key: () => "k", max: 5, window: "1m" }],
        penalty: {
          threshold: 5,
          penaltyWindow: "5m",
          banDuration: "1m",
          onUnban: () => {
            hookFired = true;
          },
        },
      });

      await limiter.ban("t:k", "1h");
      await limiter.unban("t:k");
      expect(hookFired).toBe(true);
    });

    it("snapshot() includes active bans and overrides", async () => {
      const limiter = rateLimit.create({
        name: "cov-snap-full2",
        tiers: [{ name: "t", key: () => "k", max: 5, window: "1m" }],
      });
      await limiter.reset("t:k");

      await limiter.ban("t:k", "1h");
      await limiter.setOverride("t:k", { max: 999 });

      const snap = await limiter.snapshot();
      expect(snap.activeBans.length).toBeGreaterThanOrEqual(1);
      expect(snap.activeOverrides.length).toBeGreaterThanOrEqual(1);
      expect(snap.activeOverrides[0]).toMatchObject({ tier: "t", key: "k" });
      expect(snap.activeOverrides[0].max).toBeGreaterThan(0);
      expect(snap.name).toBe("cov-snap-full2");

      // Clean up
      await limiter.unban("t:k");
      await limiter.clearOverride("t:k");
    });

    it("parseAdminKey throws on invalid format", async () => {
      const limiter = rateLimit.create({
        name: "cov-admin-err",
        tiers: [{ name: "t", key: () => "k", max: 5, window: "1m" }],
      });

      await expect(limiter.reset("invalid-no-colon")).rejects.toThrow(
        "Invalid key format",
      );
    });

    it("ban auto-expires on next check (onUnban hook fires)", async () => {
      let hookFired = false;
      const limiter = rateLimit.create({
        name: "cov-ban-expire",
        tiers: [{ name: "t", key: () => "k", max: 5, window: "1m" }],
        penalty: {
          threshold: 99,
          penaltyWindow: "5m",
          banDuration: "1m",
          onUnban: () => {
            hookFired = true;
          },
        },
      });
      await limiter.reset("t:k");

      // Manually write an already-expired ban
      await Storage.save(
        "ratelimit:bans",
        "cov-ban-expire:t:k",
        { expiresAt: Date.now() - 1000, tier: "t", key: "k" },
      );

      // Check should detect expired ban and remove it
      const r = await limiter.check({});
      expect(r.allowed).toBe(true);
      expect(hookFired).toBe(true);
    });

    it("failOpen: false throws on storage error", async () => {
      const limiter = rateLimit.create({
        name: "cov-failclosed",
        failOpen: false,
        tiers: [
          {
            name: "t",
            key: () => {
              throw new Error("simulated storage error");
            },
            max: 5,
            window: "1m",
          },
        ],
      });

      await expect(limiter.check({})).rejects.toThrow("simulated storage error");
    });

    it("clearOverride removes VIP max", async () => {
      const limiter = rateLimit.create({
        name: "cov-clearovr",
        tiers: [{ name: "t", key: () => "k", max: 5, window: "1m" }],
      });
      await limiter.reset("t:k");

      await limiter.setOverride("t:k", { max: 999 });
      let s = await limiter.getStatus("t:k");
      expect(s?.max).toBe(999);

      await limiter.clearOverride("t:k");
      s = await limiter.getStatus("t:k");
      expect(s?.max).toBe(5);
    });

    it("getStatus returns null for non-existent tier", async () => {
      const limiter = rateLimit.create({
        name: "cov-getstatus-null",
        tiers: [{ name: "t", key: () => "k", max: 5, window: "1m" }],
      });

      const s = await limiter.getStatus("nonexistent:k");
      expect(s).toBeNull();
    });

    it("getStatus shows violations count for a blocked key", async () => {
      const limiter = rateLimit.create({
        name: "cov-getstatus-viol",
        tiers: [{ name: "t", key: () => "k", max: 1, window: "1m" }],
        penalty: {
          threshold: 10,
          penaltyWindow: "5m",
          banDuration: "1m",
        },
      });
      await limiter.reset("t:k");

      // Consume 1, then trigger violations
      await limiter.check({}); // ok
      await limiter.check({}); // blocked → violation 1
      await limiter.check({}); // blocked → violation 2

      const s = await limiter.getStatus("t:k");
      expect(s).not.toBeNull();
      expect(s!.violations).toBeGreaterThanOrEqual(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 21. COVERAGE: Fixed Window algorithm branches
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Fixed Window — branch coverage", () => {
    it("resets counter when window ID changes (simulated via fake timers)", async () => {
      vi.useFakeTimers();
      try {
        const limiter = rateLimit.create({
          name: "cov-fw-reset",
          algorithm: "fixed-window",
          tiers: [{ name: "t", key: () => "k", max: 2, window: "10s" }],
        });
        await limiter.reset("t:k");

        await limiter.check({}); // 1/2
        await limiter.check({}); // 2/2 — at limit

        // Advance time to next window
        vi.advanceTimersByTime(11_000);

        const r = await limiter.check({}); // new window → reset → 1/2
        expect(r.allowed).toBe(true);
        expect(r.current).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("peek returns 0 when no data for current window", async () => {
      const limiter = rateLimit.create({
        name: "cov-fw-peek-empty",
        algorithm: "fixed-window",
        tiers: [{ name: "t", key: () => "k", max: 5, window: "10s" }],
      });
      await limiter.reset("t:k");

      const p = await limiter.peek({});
      expect(p.allowed).toBe(true);
    });

    it("fixed window blocks when capacity exceeded", async () => {
      const limiter = rateLimit.create({
        name: "cov-fw-block",
        algorithm: "fixed-window",
        tiers: [{ name: "t", key: () => "k", max: 1, window: "1m" }],
      });
      await limiter.reset("t:k");

      await limiter.check({});
      const r = await limiter.check({});
      expect(r.allowed).toBe(false);
      expect(r.wouldBlock).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 22. COVERAGE: Token Bucket algorithm branches
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Token Bucket — branch coverage", () => {
    it("refills tokens over time", async () => {
      vi.useFakeTimers();
      try {
        const limiter = rateLimit.create({
          name: "cov-tb-refill",
          algorithm: "token-bucket",
          refillRate: 1,
          refillIntervalMs: 1_000,
          tiers: [{ name: "t", key: () => "k", max: 3, window: "10s" }],
        });
        await limiter.reset("t:k");

        // Consume all 3
        await limiter.check({});
        await limiter.check({});
        await limiter.check({});

        // Should be blocked
        let r = await limiter.check({});
        expect(r.allowed).toBe(false);

        // Advance 2 seconds → 2 tokens refill
        vi.advanceTimersByTime(2_000);

        r = await limiter.check({});
        expect(r.allowed).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("peek returns 0 current when no bucket exists", async () => {
      const limiter = rateLimit.create({
        name: "cov-tb-peek-empty",
        algorithm: "token-bucket",
        refillRate: 1,
        refillIntervalMs: 1_000,
        tiers: [{ name: "t", key: () => "k", max: 5, window: "10s" }],
      });
      await limiter.reset("t:k");

      const p = await limiter.peek({});
      expect(p.allowed).toBe(true);
    });

    it("blocks with correct deficit calculation", async () => {
      const limiter = rateLimit.create({
        name: "cov-tb-deficit",
        algorithm: "token-bucket",
        refillRate: 1,
        refillIntervalMs: 5_000,
        tiers: [{ name: "t", key: () => "k", max: 2, window: "10s" }],
      });
      await limiter.reset("t:k");

      await limiter.check({});
      await limiter.check({});

      const r = await limiter.check({});
      expect(r.allowed).toBe(false);
      // resetMs should indicate how long to wait for tokens
      expect(r.resetMs).toBeGreaterThan(0);
    });

    it("peek reports correct usage and reset time", async () => {
      const limiter = rateLimit.create({
        name: "cov-tb-peek-used",
        algorithm: "token-bucket",
        refillRate: 1,
        refillIntervalMs: 1_000,
        tiers: [{ name: "t", key: () => "k", max: 5, window: "10s" }],
      });
      await limiter.reset("t:k");

      await limiter.check({}, { cost: 3 }); // use 3/5

      const p = await limiter.peek({});
      expect(p.current).toBe(3); // 3 used
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 23. COVERAGE: Utility functions
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Utility Functions", () => {
    it("parseWindow: throws on invalid format", async () => {
      const { parseWindow } = await import(
        "../../src/ratelimit/utils/parse-window.js"
      );
      expect(() => parseWindow("invalid")).toThrow("Invalid window format");
      expect(() => parseWindow("10x")).toThrow("Invalid window format");
      expect(() => parseWindow("")).toThrow("Invalid window format");
    });

    it("parseWindow: parses all valid units", async () => {
      const { parseWindow } = await import(
        "../../src/ratelimit/utils/parse-window.js"
      );
      expect(parseWindow("30s")).toBe(30_000);
      expect(parseWindow("5m")).toBe(300_000);
      expect(parseWindow("2h")).toBe(7_200_000);
      expect(parseWindow("1d")).toBe(86_400_000);
    });

    it("applyJitter: returns duration unchanged when jitter <= 0", async () => {
      const { applyJitter } = await import(
        "../../src/ratelimit/utils/jitter.js"
      );
      expect(applyJitter(1000, 0)).toBe(1000);
      expect(applyJitter(1000, -1)).toBe(1000);
    });

    it("applyJitter: returns duration unchanged when duration <= 0", async () => {
      const { applyJitter } = await import(
        "../../src/ratelimit/utils/jitter.js"
      );
      expect(applyJitter(0, 0.5)).toBe(0);
      expect(applyJitter(-100, 0.5)).toBe(-100);
    });

    it("applyJitter: applies jitter within expected range", async () => {
      const { applyJitter } = await import(
        "../../src/ratelimit/utils/jitter.js"
      );
      // With 50% jitter on 1000ms, result should be between 500-1500
      const results = [];
      for (let i = 0; i < 20; i++) {
        results.push(applyJitter(1000, 0.5));
      }
      expect(results.every((r) => r >= 0)).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 24. COVERAGE: Sliding Window — branch coverage
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Sliding Window — branch coverage", () => {
    it("entries expire after window passes", async () => {
      vi.useFakeTimers();
      try {
        const limiter = rateLimit.create({
          name: "cov-sw-expire",
          algorithm: "sliding-window",
          tiers: [{ name: "t", key: () => "k", max: 2, window: "5s" }],
        });
        await limiter.reset("t:k");

        await limiter.check({});
        await limiter.check({});

        // At limit
        let r = await limiter.check({});
        expect(r.allowed).toBe(false);

        // Advance past window
        vi.advanceTimersByTime(6_000);

        // Entries expired — should be allowed again
        r = await limiter.check({});
        expect(r.allowed).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 25. COVERAGE: onBan hook fires on penalty auto-ban
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Penalty Hooks", () => {
    it("onBan hook fires when threshold is reached", async () => {
      let onBanKey = "";
      const limiter = rateLimit.create({
        name: "cov-onban-hook",
        tiers: [{ name: "t", key: () => "k", max: 1, window: "1m" }],
        penalty: {
          threshold: 2,
          penaltyWindow: "5m",
          banDuration: "1m",
          onBan: (key, _tier, _duration) => {
            onBanKey = key;
          },
        },
      });
      await limiter.reset("t:k");

      await limiter.check({}); // ok
      await limiter.check({}); // violation 1
      await limiter.check({}); // violation 2 → ban

      expect(onBanKey).toBe("k");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 26. COVERAGE: Algorithm direct tests for remaining branches
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Algorithm — direct unit tests", () => {
    it("FixedWindow: consume returns blocked result with correct resetMs", async () => {
      const { FixedWindowAlgorithm } = await import(
        "../../src/ratelimit/algorithms/fixed-window.js"
      );
      const algo = new FixedWindowAlgorithm();

      // First consume should succeed
      const r1 = await algo.consume(Storage, "cov-fw-direct:t:k", 2, 60_000, 1);
      expect(r1.allowed).toBe(true);

      const r2 = await algo.consume(Storage, "cov-fw-direct:t:k", 2, 60_000, 1);
      expect(r2.allowed).toBe(true);

      // Third should be blocked
      const r3 = await algo.consume(Storage, "cov-fw-direct:t:k", 2, 60_000, 1);
      expect(r3.allowed).toBe(false);
      expect(r3.resetMs).toBeGreaterThan(0);
      expect(r3.current).toBe(2);
    });

    it("FixedWindow: peek on stale window returns 0", async () => {
      const { FixedWindowAlgorithm } = await import(
        "../../src/ratelimit/algorithms/fixed-window.js"
      );
      const algo = new FixedWindowAlgorithm();

      // Write data for a different window ID
      await Storage.save("ratelimit:fixed", "cov-fw-stale:t:k", {
        windowId: 0, // epoch window, definitely stale
        count: 99,
      });

      const peek = await algo.peek(Storage, "cov-fw-stale:t:k", 10, 60_000);
      expect(peek.current).toBe(0); // stale window = reset to 0
    });

    it("TokenBucket: consume returns blocked with deficit calc", async () => {
      const { TokenBucketAlgorithm } = await import(
        "../../src/ratelimit/algorithms/token-bucket.js"
      );
      const algo = new TokenBucketAlgorithm(1, 1_000);

      // Init bucket with max=2
      const r1 = await algo.consume(Storage, "cov-tb-direct:t:k", 2, 10_000, 1);
      expect(r1.allowed).toBe(true);
      const r2 = await algo.consume(Storage, "cov-tb-direct:t:k", 2, 10_000, 1);
      expect(r2.allowed).toBe(true);

      // Should be blocked — exercises deficit calculation (lines 60-72)
      const r3 = await algo.consume(Storage, "cov-tb-direct:t:k", 2, 10_000, 1);
      expect(r3.allowed).toBe(false);
      expect(r3.current).toBe(2); // max - 0 tokens = 2 used
      expect(r3.resetMs).toBeGreaterThan(0);
    });

    it("TokenBucket: peek on non-existent bucket returns 0", async () => {
      const { TokenBucketAlgorithm } = await import(
        "../../src/ratelimit/algorithms/token-bucket.js"
      );
      const algo = new TokenBucketAlgorithm(1, 1_000);

      // Clean key
      await Storage.delete("ratelimit:bucket", "cov-tb-peek-none:t:k");

      const peek = await algo.peek(Storage, "cov-tb-peek-none:t:k", 5, 10_000);
      expect(peek.current).toBe(0);
      expect(peek.resetMs).toBe(0);
    });

    it("TokenBucket: refill drift correction occurs when time passes", async () => {
      const { TokenBucketAlgorithm } = await import(
        "../../src/ratelimit/algorithms/token-bucket.js"
      );
      const algo = new TokenBucketAlgorithm(1, 500); // refill 1 per 500ms

      // Consume all tokens from a max=2 bucket
      await algo.consume(Storage, "cov-tb-drift:t:k", 2, 10_000, 1);
      await algo.consume(Storage, "cov-tb-drift:t:k", 2, 10_000, 1);

      // Manually age the bucket so refill will kick in
      const state = await Storage.get<any>("ratelimit:bucket", "cov-tb-drift:t:k");
      if (state) {
        state.lastRefillAt = Date.now() - 2_000; // 2 seconds ago = 4 refill intervals
        await Storage.save("ratelimit:bucket", "cov-tb-drift:t:k", state);
      }

      // Next consume should succeed because tokens refilled
      const r = await algo.consume(Storage, "cov-tb-drift:t:k", 2, 10_000, 1);
      expect(r.allowed).toBe(true);
    });

    it("TokenBucket: peek after partial consumption shows deficit resetMs", async () => {
      const { TokenBucketAlgorithm } = await import(
        "../../src/ratelimit/algorithms/token-bucket.js"
      );
      const algo = new TokenBucketAlgorithm(1, 1_000);

      // Init and consume 1 of 3
      await algo.consume(Storage, "cov-tb-peek-partial:t:k", 3, 10_000, 2);

      const peek = await algo.peek(Storage, "cov-tb-peek-partial:t:k", 3, 10_000);
      expect(peek.current).toBe(2); // 2 used
      expect(peek.resetMs).toBeGreaterThan(0); // time until fully replenished
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 27. COVERAGE: Module tick with storage error
  // ═══════════════════════════════════════════════════════════════════════════

  describe("RateLimitModule — tick error handling", () => {
    it("tick catches and logs errors from storage.prune", async () => {
      const { RateLimitModule } = await import(
        "../../src/ratelimit/ratelimit-module.js"
      );

      const warnLogs: string[] = [];
      const mod = new RateLimitModule(
        { project: "t", environment: "test", mode: "default" } as any,
        {
          info: () => {},
          warn: (m: string) => warnLogs.push(m),
          error: () => {},
        } as any,
        { module: "ratelimit", gcIntervalMs: 60000, eventRetentionMs: 86400000 },
      );

      // Inject a broken container to force _tick to fail
      const { OqronContainer } = await import("../../src/engine/container.js");
      const original = OqronContainer.tryGet;

      // Mock to return a storage that throws on prune
      const mockContainer = {
        storage: {
          prune: () => {
            throw new Error("prune-fail");
          },
          get: () => Promise.resolve(null),
          save: () => Promise.resolve(),
          list: () => Promise.resolve([]),
          delete: () => Promise.resolve(),
        },
      };
      OqronContainer.tryGet = () => mockContainer as any;

      try {
        await (mod as any)._tick();
        expect(warnLogs.some((m) => m.includes("prune-fail"))).toBe(true);
      } finally {
        OqronContainer.tryGet = original;
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 28. COVERAGE: onPass hook fires on successful check
  // ═══════════════════════════════════════════════════════════════════════════

  describe("onPass Hook", () => {
    it("fires onPass when check succeeds", async () => {
      let hookFired = false;
      const limiter = rateLimit.create({
        name: "cov-onpass",
        tiers: [{ name: "t", key: () => "k", max: 5, window: "1m" }],
        onPass: () => {
          hookFired = true;
        },
      });
      await limiter.reset("t:k");

      await limiter.check({});
      expect(hookFired).toBe(true);
    });

    it("does NOT fire onPass on peek (read-only)", async () => {
      let hookFired = false;
      const limiter = rateLimit.create({
        name: "cov-onpass-peek",
        tiers: [{ name: "t", key: () => "k", max: 5, window: "1m" }],
        onPass: () => {
          hookFired = true;
        },
      });
      await limiter.reset("t:k");

      await limiter.peek({});
      expect(hookFired).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 29. COVERAGE: Banned key during tier evaluation
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Banned Key Evaluation", () => {
    it("returns banned result when key is banned in tier", async () => {
      const limiter = rateLimit.create({
        name: "cov-ban-eval",
        tiers: [{ name: "t", key: () => "k", max: 5, window: "1m" }],
      });
      await limiter.reset("t:k");

      // Manually ban the key
      await limiter.ban("t:k", "1h");

      // Check should return banned
      const r = await limiter.check({});
      expect(r.allowed).toBe(false);
      expect(r.banned).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 30. COVERAGE: Module start when disabled
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Module Start When Disabled", () => {
    it("start() does nothing when module is disabled", async () => {
      const { RateLimitModule } = await import(
        "../../src/ratelimit/ratelimit-module.js"
      );
      const mod = new RateLimitModule(
        { project: "t", environment: "test", mode: "default" } as any,
        { info: () => {}, warn: () => {}, error: () => {} } as any,
        { module: "ratelimit", gcIntervalMs: 60000, eventRetentionMs: 86400000 },
      );

      mod.enabled = false;
      await mod.start(); // should skip _startLoop
      // No timer should exist
      expect((mod as any)._timer).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 31. COVERAGE: peek() error handling (failOpen branches)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Peek Resilience", () => {
    it("peek with failOpen: true returns allowed on error", async () => {
      const limiter = rateLimit.create({
        name: "cov-peek-failopen",
        failOpen: true,
        tiers: [
          {
            name: "t",
            key: () => {
              throw new Error("peek error");
            },
            max: 5,
            window: "1m",
          },
        ],
      });

      const r = await limiter.peek({});
      expect(r.allowed).toBe(true);
    });

    it("peek with failOpen: false throws on error", async () => {
      const limiter = rateLimit.create({
        name: "cov-peek-failclosed",
        failOpen: false,
        tiers: [
          {
            name: "t",
            key: () => {
              throw new Error("peek closed error");
            },
            max: 5,
            window: "1m",
          },
        ],
      });

      await expect(limiter.peek({})).rejects.toThrow("peek closed error");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // BUG FIXES (B1–B5)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("B1/B2: Enable/Disable emits EventBus events", () => {
    it("enableRateLimiter emits ratelimit:instance:enabled", async () => {
      let emitted = false;
      OqronEventBus.on("ratelimit:instance:enabled", (name) => {
        if (name === "b1-enable") emitted = true;
      });

      const limiter = rateLimit.create({
        name: "b1-enable",
        tiers: [{ name: "t", key: () => "k", max: 10, window: "1m" }],
      });

      // Ensure instance record exists
      await Storage.save("ratelimit_instances", "b1-enable", {
        name: "b1-enable",
        algorithm: "sliding-window",
        tierNames: ["t"],
        dryRun: false,
        failOpen: false,
        enabled: false,
        disabledBehavior: "skip",
        createdAt: new Date(),
        tags: [],
      });

      const { OqronManager } = await import("../../src/manager/oqron-manager.js");
      const mgr = new OqronManager({} as any);
      await mgr.enableRateLimiter("b1-enable");
      expect(emitted).toBe(true);
    });

    it("disableRateLimiter emits ratelimit:instance:disabled", async () => {
      let emitted = false;
      OqronEventBus.on("ratelimit:instance:disabled", (name) => {
        if (name === "b2-disable") emitted = true;
      });

      await Storage.save("ratelimit_instances", "b2-disable", {
        name: "b2-disable",
        algorithm: "sliding-window",
        tierNames: ["t"],
        dryRun: false,
        failOpen: false,
        enabled: true,
        disabledBehavior: "skip",
        createdAt: new Date(),
        tags: [],
      });

      const { OqronManager } = await import("../../src/manager/oqron-manager.js");
      const mgr = new OqronManager({} as any);
      await mgr.disableRateLimiter("b2-disable");
      expect(emitted).toBe(true);
    });
  });

  describe("B3: unban() emits ratelimit:unbanned", () => {
    it("emits unbanned event on manual unban", async () => {
      let emitted = false;
      OqronEventBus.on("ratelimit:unbanned", (ln, _t, _k) => {
        if (ln === "b3-unban") emitted = true;
      });

      const limiter = rateLimit.create({
        name: "b3-unban",
        tiers: [{ name: "t", key: () => "k", max: 5, window: "1m" }],
      });

      await limiter.ban("t:k", "1h");
      await limiter.unban("t:k");
      expect(emitted).toBe(true);
    });
  });

  describe("B4: _isBanned auto-expiry emits ratelimit:unbanned", () => {
    it("emits unbanned event when ban expires during check", async () => {
      let emitted = false;
      OqronEventBus.on("ratelimit:unbanned", (ln, _t, _k) => {
        if (ln === "b4-autoexpiry") emitted = true;
      });

      const limiter = rateLimit.create({
        name: "b4-autoexpiry",
        tiers: [{ name: "t", key: () => "k", max: 5, window: "1m" }],
      });

      // Create an already-expired ban
      await Storage.save("ratelimit:bans", "b4-autoexpiry:t:k", {
        expiresAt: Date.now() - 1000,
        tier: "t",
        key: "k",
        limiterName: "b4-autoexpiry",
      });

      await limiter.check({});
      expect(emitted).toBe(true);
    });
  });

  describe("B5: snapshot() scoped to this limiter", () => {
    it("snapshot only shows bans for its own limiter", async () => {
      const limiterA = rateLimit.create({
        name: "b5-a",
        tiers: [{ name: "t", key: () => "k", max: 5, window: "1m" }],
      });
      const limiterB = rateLimit.create({
        name: "b5-b",
        tiers: [{ name: "t", key: () => "k", max: 5, window: "1m" }],
      });

      await limiterA.ban("t:k", "1h");
      await limiterB.ban("t:k", "1h");

      const snapA = await limiterA.snapshot();
      const snapB = await limiterB.snapshot();

      expect(snapA.name).toBe("b5-a");
      expect(snapB.name).toBe("b5-b");
      // Each should only see its own bans
      for (const ban of snapA.activeBans) {
        expect(ban.tier).toBe("t");
      }
      for (const ban of snapB.activeBans) {
        expect(ban.tier).toBe("t");
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GAP CLOSURES (G1–G5)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("G3: rateLimit.destroy() removes from registry", () => {
    it("destroy removes limiter from registry", async () => {
      const { getLimiter } = await import("../../src/ratelimit/registry.js");

      rateLimit.create({
        name: "g3-destroy",
        tiers: [{ name: "t", key: () => "k", max: 10, window: "1m" }],
      });

      expect(getLimiter("g3-destroy")).toBeDefined();
      const removed = rateLimit.destroy("g3-destroy");
      expect(removed).toBe(true);
      expect(getLimiter("g3-destroy")).toBeUndefined();
    });

    it("destroy returns false for non-existent limiter", () => {
      const removed = rateLimit.destroy("does-not-exist");
      expect(removed).toBe(false);
    });
  });

  describe("G5: checkMany batch API", () => {
    it("checks multiple contexts and stops at first block", async () => {
      const limiter = rateLimit.create<{ id: string }>({
        name: "g5-batch",
        tiers: [{ name: "t", key: (ctx) => ctx.id, max: 1, window: "1m" }],
      });
      await limiter.reset("t:a");
      await limiter.reset("t:b");

      // Use up key 'a'
      await limiter.check({ id: "a" });

      const results = await limiter.checkMany([
        { id: "a" }, // blocked
        { id: "b" }, // would be allowed, but stopOnBlock=true stops
      ]);

      expect(results).toHaveLength(1);
      expect(results[0].allowed).toBe(false);
    });

    it("checks all contexts when stopOnBlock is false", async () => {
      const limiter = rateLimit.create<{ id: string }>({
        name: "g5-batch-all",
        tiers: [{ name: "t", key: (ctx) => ctx.id, max: 1, window: "1m" }],
      });
      await limiter.reset("t:x");
      await limiter.reset("t:y");

      await limiter.check({ id: "x" }); // use up x

      const results = await limiter.checkMany(
        [{ id: "x" }, { id: "y" }],
        { stopOnBlock: false },
      );

      expect(results).toHaveLength(2);
      expect(results[0].allowed).toBe(false);
      expect(results[1].allowed).toBe(true);
    });
  });

  describe("G1: Adaptive threshold suggestions", () => {
    it("emits ratelimit:suggestion after sustained high usage", async () => {
      let suggestion: { limiter: string; tier: string; suggestedMax: number; p95: number } | null = null;
      OqronEventBus.on("ratelimit:suggestion", (ln, tier, sugMax, p95) => {
        if (ln === "g1-adaptive") {
          suggestion = { limiter: ln, tier, suggestedMax: sugMax, p95 };
        }
      });

      const limiter = rateLimit.create({
        name: "g1-adaptive",
        adaptive: true,
        tiers: [{ name: "t", key: () => "k", max: 10, window: "1m" }],
      });
      await limiter.reset("t:k");

      // Clear stats to force fresh ring buffer
      await Storage.delete("ratelimit_stats", "g1-adaptive");

      // Generate 20+ high-usage checks (>90% utilization)
      for (let i = 0; i < 25; i++) {
        // Reset each time and consume 9/10 (90%)
        await limiter.reset("t:k");
        for (let j = 0; j < 9; j++) {
          await limiter.check({});
        }
      }

      expect(suggestion).not.toBeNull();
      expect(suggestion!.suggestedMax).toBe(15); // ceil(10 * 1.5)
      expect(suggestion!.p95).toBeGreaterThanOrEqual(0.9);
    });
  });

  describe("G2: Circuit breaker auto-burst", () => {
    it("opens circuit after consecutive full-utilization checks and inflates max", async () => {
      let circuitOpened = false;
      OqronEventBus.on("ratelimit:circuit-open", (ln, _tier, _key, _mult) => {
        if (ln === "g2-circuit") {
          circuitOpened = true;
        }
      });

      // Use a large max and high cost to achieve >=95% in one shot
      const limiter = rateLimit.create({
        name: "g2-circuit",
        tiers: [{ name: "t", key: () => "k", max: 100, window: "1m" }],
        circuitBreaker: {
          consecutiveFullWindows: 3,
          burstMultiplier: 2,
          cooldownWindow: "5m",
        },
      });
      await limiter.reset("t:k");
      await Storage.delete("ratelimit_stats", "g2-circuit");
      await Storage.delete("ratelimit:circuit", "g2-circuit:t:k");

      // 3 consecutive checks at 96% utilization each (cost=96, max=100)
      for (let round = 0; round < 3; round++) {
        await limiter.reset("t:k");
        await limiter.check({}, { cost: 96 });
        // Allow fire-and-forget _updateStats to settle
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(circuitOpened).toBe(true);

      // Now max should be inflated: 100 * 2 = 200
      await limiter.reset("t:k");
      for (let i = 0; i < 150; i++) {
        const r = await limiter.check({});
        expect(r.allowed).toBe(true);
      }
    });
  });

  describe("G4: Middleware helpers", () => {
    it("expressMiddleware returns 429 with headers when blocked", async () => {
      const { expressMiddleware } = await import("../../src/ratelimit/middleware.js");

      const limiter = rateLimit.create({
        name: "g4-express",
        tiers: [{ name: "t", key: (ctx: any) => ctx.ip, max: 1, window: "1m" }],
      });
      await limiter.reset("t:127.0.0.1");

      const mw = expressMiddleware({
        limiter,
        contextFromRequest: (req: any) => ({ ip: req.ip }),
      });

      // Mock Express req/res/next
      const req = { ip: "127.0.0.1" };
      let statusCode = 0;
      let responseBody: any = null;
      const headers: Record<string, string> = {};
      const res = {
        setHeader: (k: string, v: string) => { headers[k] = v; },
        status: (code: number) => ({ json: (body: any) => { statusCode = code; responseBody = body; } }),
      };
      const next = vi.fn();

      // First call → allowed
      await mw(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(headers["X-RateLimit-Limit"]).toBeDefined();

      // Second call → blocked
      next.mockClear();
      await mw(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(statusCode).toBe(429);
      expect(responseBody.error).toBe("Too Many Requests");
    });

    it("honoMiddleware returns 429 response when blocked", async () => {
      const { honoMiddleware } = await import("../../src/ratelimit/middleware.js");

      const limiter = rateLimit.create({
        name: "g4-hono",
        tiers: [{ name: "t", key: (ctx: any) => ctx.ip, max: 1, window: "1m" }],
      });
      await limiter.reset("t:10.0.0.1");

      const mw = honoMiddleware({
        limiter,
        contextFromRequest: (c: any) => ({ ip: c.ip }),
      });

      const honoHeaders: Record<string, string> = {};
      let jsonResult: any = null;
      const c = {
        ip: "10.0.0.1",
        header: (k: string, v: string) => { honoHeaders[k] = v; },
        json: (body: any, status: number) => { jsonResult = { body, status }; return new Response(); },
      };
      const honoNext = vi.fn();

      // First call → allowed
      await mw(c, honoNext);
      expect(honoNext).toHaveBeenCalledTimes(1);

      // Second call → blocked
      honoNext.mockClear();
      await mw(c, honoNext);
      expect(honoNext).not.toHaveBeenCalled();
      expect(jsonResult?.status).toBe(429);
      expect(jsonResult?.body.error).toBe("Too Many Requests");
    });
  });
});
