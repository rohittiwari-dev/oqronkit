import { randomUUID } from "node:crypto";
import { OqronContainer } from "../engine/container.js";
import { OqronEventBus } from "../engine/events/event-bus.js";
import type { IStorageEngine } from "../engine/types/engine.js";
import { FixedWindowAlgorithm } from "./algorithms/fixed-window.js";
import { SlidingWindowAlgorithm } from "./algorithms/sliding-window.js";
import { TokenBucketAlgorithm } from "./algorithms/token-bucket.js";
import type {
  CheckOptions,
  IRateLimitAlgorithm,
  IRateLimiter,
  RateLimitConfig,
  RateLimitInstanceRecord,
  RateLimitKeyStatus,
  RateLimitResult,
  RateLimitSnapshot,
  RateLimitStats,
  TierBreakdown,
  WindowDuration,
} from "./types.js";
import { buildHeaders } from "./utils/headers.js";
import { applyJitter } from "./utils/jitter.js";
import { parseWindow } from "./utils/parse-window.js";
import { getLimiter as _getLimiter } from "./registry.js";

// ── Storage Key Builders ────────────────────────────────────────────────────

function dataKey(limiterName: string, tier: string, key: string): string {
  return `${limiterName}:${tier}:${key}`;
}

const NS_OVERRIDES = "ratelimit:overrides";
const NS_BANS = "ratelimit:bans";
const NS_VIOLATIONS = "ratelimit:violations";
const NS_WARNINGS = "ratelimit:warnings";

function overrideId(limiterName: string, tier: string, key: string): string {
  return `${limiterName}:${tier}:${key}`;
}

function banId(limiterName: string, tier: string, key: string): string {
  return `${limiterName}:${tier}:${key}`;
}

function violationId(limiterName: string, tier: string, key: string): string {
  return `${limiterName}:${tier}:${key}`;
}

function warningId(
  limiterName: string,
  tier: string,
  key: string,
  pct: number,
): string {
  return `${limiterName}:${tier}:${key}:${pct}`;
}

// ── Ban Record ──────────────────────────────────────────────────────────────

interface BanRecord {
  expiresAt: number; // epoch ms
  tier: string;
  key: string;
}

interface ViolationRecord {
  timestamps: number[];
}

interface OverrideRecord {
  max: number;
}

interface WarningFired {
  firedAt: number;
  windowId: number;
}

// ── Helper: Parse a composite admin key "tierName:resolvedKey" ───────────────

function parseAdminKey(adminKey: string): { tier: string; key: string } {
  const idx = adminKey.indexOf(":");
  if (idx === -1) {
    throw new Error(
      `[OqronKit:RateLimit] Invalid key format: "${adminKey}". Expected "tierName:resolvedKey".`,
    );
  }
  return { tier: adminKey.slice(0, idx), key: adminKey.slice(idx + 1) };
}

// ── Engine ──────────────────────────────────────────────────────────────────

/**
 * RateLimitEngine — Core implementation of the distributed rate limiter.
 *
 * Design:
 * - Not an IOqronModule (no background polling / ticks)
 * - Purely evaluated at the moment check() is called (Egress Policy Engine)
 * - All state persisted through IStorageEngine (Memory, Redis, or Postgres)
 * - Atomicity: peek all tiers first, commit only if all tiers pass
 */
export class RateLimitEngine<TContext = any> implements IRateLimiter<TContext> {
  readonly name: string;
  private readonly config: RateLimitConfig<TContext>;
  private readonly algorithm: IRateLimitAlgorithm;
  private readonly jitterFraction: number;
  private readonly failOpen: boolean;
  private readonly dryRun: boolean;

  constructor(config: RateLimitConfig<TContext>) {
    this.name = config.name;
    this.config = config;
    this.jitterFraction = config.jitter ?? 0.1;
    this.failOpen = config.failOpen ?? false;
    this.dryRun = config.dryRun ?? false;

    // Resolve algorithm
    const algo = config.algorithm ?? "sliding-window";
    switch (algo) {
      case "sliding-window":
        this.algorithm = new SlidingWindowAlgorithm();
        break;
      case "token-bucket":
        this.algorithm = new TokenBucketAlgorithm(
          config.refillRate ?? 1,
          config.refillIntervalMs ?? 1_000,
        );
        break;
      case "fixed-window":
        this.algorithm = new FixedWindowAlgorithm();
        break;
      default:
        throw new Error(
          `[OqronKit:RateLimit] Unknown algorithm: "${algo}". Use: sliding-window, token-bucket, fixed-window.`,
        );
    }
  }

  /** Resolve storage — either from container or throw if not initialized */
  private getStorage(): IStorageEngine {
    const container = OqronContainer.tryGet();
    if (!container) {
      throw new Error(
        "[OqronKit:RateLimit] OqronKit not initialized. Call OqronKit.init() before using rate limiters.",
      );
    }
    return container.storage;
  }

  // ── check() — The Main Entry Point ──────────────────────────────────────

  async check(
    ctx: TContext,
    opts?: CheckOptions,
  ): Promise<RateLimitResult> {
    const storage = this.getStorage();

    // ── Instance toggle check ───────────────────────────────────────────
    const instanceRec = await storage.get<RateLimitInstanceRecord>(
      "ratelimit_instances",
      this.name,
    );
    if (instanceRec && !instanceRec.enabled) {
      const behavior = instanceRec.disabledBehavior ?? "skip";
      if (behavior === "block") {
        return this._buildDisabledResult(true);
      }
      if (behavior === "skip") {
        return this._buildDisabledResult(false);
      }
      // "passthrough" — continue but mark result.passthrough = true
    }
    const isPassthrough = instanceRec ? !instanceRec.enabled : false;

    // ── Cost estimation ─────────────────────────────────────────────────
    let cost = opts?.cost ?? 1;
    if (opts?.cost === undefined && this.config.costEstimator) {
      cost = this.config.costEstimator(ctx);
    }

    // ── DependsOn chaining ──────────────────────────────────────────────
    if (this.config.dependsOn && this.config.dependsOn.length > 0) {
      for (const depName of this.config.dependsOn) {
        const depLimiter = _getLimiter(depName);
        if (depLimiter) {
          // Peek with cost=1 to see if upstream has capacity for one more request
          // without actually consuming any tokens.
          const depResult = await depLimiter.peek(ctx, 1);
          if (!depResult.allowed) {
            // Dependency limiter is blocked — propagate block
            const result: RateLimitResult = {
              allowed: false,
              wouldBlock: true,
              tier: `dep:${depName}`,
              current: depResult.current,
              limit: depResult.limit,
              remaining: 0,
              resetMs: depResult.resetMs,
              retryAfterSecs: depResult.retryAfterSecs,
              retryAfter: depResult.retryAfter,
              banned: false,
              skipped: false,
              instanceDisabled: false,
              passthrough: false,
              breakdown: [],
              toHeaders: () => buildHeaders(result),
            };
            return result;
          }
        }
      }
    }

    try {
      const result = await this._evaluate(ctx, cost, storage, false);
      // Tag passthrough if instance was disabled with passthrough behavior
      if (isPassthrough) {
        (result as any).passthrough = true;
        (result as any).instanceDisabled = true;
        (result as any).allowed = true; // passthrough always allows
      }
      // ── Stats + event write (fire-and-forget, don't block response) ──
      void this._updateStats(storage, result).catch(() => {});
      if (!result.allowed && !this.dryRun) {
        void this._writeBlockEvent(
          storage,
          result,
          cost,
        ).catch(() => {});
      }
      return result;
    } catch (err) {
      if (this.failOpen) {
        return this._buildAllowedResult([], true);
      }
      throw err;
    }
  }

  // ── peek() — Read-Only Check ────────────────────────────────────────────

  /**
   * Read-only evaluation. Does not consume tokens.
   * @param ctx - The request context.
   * @param cost - Optional cost to evaluate (default: 0 = "is current state within limits?").
   *              Use cost=1 to check "would the next request be allowed?" without consuming.
   */
  async peek(ctx: TContext, cost: number = 0): Promise<RateLimitResult> {
    const storage = this.getStorage();

    try {
      return await this._evaluate(ctx, cost, storage, true);
    } catch (err) {
      if (this.failOpen) {
        return this._buildAllowedResult([], true);
      }
      throw err;
    }
  }

  // ── Core Evaluation Flow ──────────────────────────────────────────────────

  private async _evaluate(
    ctx: TContext,
    cost: number,
    storage: IStorageEngine,
    peekOnly: boolean,
  ): Promise<RateLimitResult> {
    // ── Step 1: Global skip ──────────────────────────────────────────────
    if (this.config.skip) {
      const shouldSkip = await this.config.skip(ctx);
      if (shouldSkip) {
        return this._buildSkippedResult();
      }
    }

    // ── Step 2: Evaluate each tier ───────────────────────────────────────
    const breakdown: TierBreakdown[] = [];
    let blockingTier: {
      name: string;
      key: string;
      current: number;
      max: number;
      resetMs: number;
      banned: boolean;
    } | null = null;

    // Phase 1: Peek all tiers to check if any block (atomicity rule)
    const tierEvals: Array<{
      tierName: string;
      key: string;
      max: number;
      windowMs: number;
      storageKey: string;
      current: number;
      resetMs: number;
      allowed: boolean;
      skipped: boolean;
      banned: boolean;
    }> = [];

    for (const tier of this.config.tiers) {
      // Check if tier is conditionally enabled
      if (tier.enabled && !tier.enabled(ctx)) {
        breakdown.push({
          name: tier.name,
          key: "",
          current: 0,
          max: tier.max,
          remaining: tier.max,
          allowed: true,
          skipped: true,
        });
        tierEvals.push({
          tierName: tier.name,
          key: "",
          max: tier.max,
          windowMs: 0,
          storageKey: "",
          current: 0,
          resetMs: 0,
          allowed: true,
          skipped: true,
          banned: false,
        });
        continue;
      }

      // Resolve key
      const resolvedKey = tier.key(ctx);
      if (resolvedKey == null) {
        breakdown.push({
          name: tier.name,
          key: "",
          current: 0,
          max: tier.max,
          remaining: tier.max,
          allowed: true,
          skipped: true,
        });
        tierEvals.push({
          tierName: tier.name,
          key: "",
          max: tier.max,
          windowMs: 0,
          storageKey: "",
          current: 0,
          resetMs: 0,
          allowed: true,
          skipped: true,
          banned: false,
        });
        continue;
      }

      const windowMs = parseWindow(tier.window);
      const storageKey = dataKey(this.name, tier.name, resolvedKey);

      // Check ban BEFORE algorithm
      const banned = await this._isBanned(storage, tier.name, resolvedKey);
      if (banned) {
        const banRec = await storage.get<BanRecord>(
          NS_BANS,
          banId(this.name, tier.name, resolvedKey),
        );
        const resetMs = banRec
          ? Math.max(0, banRec.expiresAt - Date.now())
          : 0;

        breakdown.push({
          name: tier.name,
          key: resolvedKey,
          current: tier.max,
          max: tier.max,
          remaining: 0,
          allowed: false,
          skipped: false,
        });

        if (!blockingTier) {
          blockingTier = {
            name: tier.name,
            key: resolvedKey,
            current: tier.max,
            max: tier.max,
            resetMs,
            banned: true,
          };
        }

        tierEvals.push({
          tierName: tier.name,
          key: resolvedKey,
          max: tier.max,
          windowMs,
          storageKey,
          current: tier.max,
          resetMs,
          allowed: false,
          skipped: false,
          banned: true,
        });
        continue;
      }

      // Check override for this key
      const overrideRec = await storage.get<OverrideRecord>(
        NS_OVERRIDES,
        overrideId(this.name, tier.name, resolvedKey),
      );
      const effectiveMax = overrideRec?.max ?? tier.max;

      // Peek algorithm state (no mutation)
      const peekResult = await this.algorithm.peek(
        storage,
        storageKey,
        effectiveMax,
        windowMs,
      );

      const tierAllowed = peekResult.current + cost <= effectiveMax;
      const finalCurrent = tierAllowed ? peekResult.current + cost : peekResult.current;

      breakdown.push({
        name: tier.name,
        key: resolvedKey,
        current: finalCurrent,
        max: effectiveMax,
        remaining: Math.max(0, effectiveMax - finalCurrent),
        allowed: tierAllowed,
        skipped: false,
      });

      if (!tierAllowed && !blockingTier) {
        blockingTier = {
          name: tier.name,
          key: resolvedKey,
          current: finalCurrent,
          max: effectiveMax,
          resetMs: peekResult.resetMs,
          banned: false,
        };
      }

      tierEvals.push({
        tierName: tier.name,
        key: resolvedKey,
        max: effectiveMax,
        windowMs,
        storageKey,
        current: finalCurrent,
        resetMs: peekResult.resetMs,
        allowed: tierAllowed,
        skipped: false,
        banned: false,
      });
    }

    // ── Step 3: Decision ────────────────────────────────────────────────

    if (blockingTier) {
      // BLOCKED — handle penalty escalation, hooks, dry-run
      let finalBanned = blockingTier.banned;
      let finalResetMs = blockingTier.resetMs;

      // Track violation for penalty escalation
      if (
        this.config.penalty &&
        !blockingTier.banned &&
        !peekOnly
      ) {
        const pResult = await this._recordViolation(
          storage,
          blockingTier.name,
          blockingTier.key,
        );
        if (pResult.banned) {
          finalBanned = true;
          finalResetMs = pResult.banDurationMs;
        }
      }

      const retryAfterMs = applyJitter(finalResetMs, this.jitterFraction);
      const retryAfterSecs = Math.ceil(retryAfterMs / 1000);

      const wouldBlock = true;
      const allowed = this.dryRun;

      const result: RateLimitResult = {
        allowed,
        wouldBlock,
        tier: blockingTier.name,
        current: blockingTier.current,
        limit: blockingTier.max,
        remaining: 0,
        resetMs: finalResetMs,
        retryAfterSecs,
        retryAfter: new Date(Date.now() + retryAfterMs),
        banned: finalBanned,
        skipped: false,
        instanceDisabled: false,
        passthrough: false,
        breakdown,
        toHeaders: () => buildHeaders(result),
      };

      // Fire onLimit hook
      if (this.config.onLimit) {
        result.error = await this.config.onLimit(ctx, result);
      }

      // EventBus emission
      OqronEventBus.emit(
        "ratelimit:blocked",
        this.name,
        blockingTier.name,
        blockingTier.key,
        result,
      );

      // In dry-run, we still need to consume tokens if not peek-only
      if (this.dryRun && !peekOnly && cost > 0) {
        for (const ev of tierEvals) {
          if (!ev.skipped && !ev.banned) {
            await this.algorithm.consume(
              storage,
              ev.storageKey,
              ev.max,
              ev.windowMs,
              cost,
            );
          }
        }
      }

      return result;
    }

    // ALL TIERS PASSED — commit consumption atomically
    if (!peekOnly && cost > 0) {
      for (const ev of tierEvals) {
        if (!ev.skipped && !ev.banned) {
          await this.algorithm.consume(
            storage,
            ev.storageKey,
            ev.max,
            ev.windowMs,
            cost,
          );
        }
      }
    }

    // Fire quota warnings
    if (this.config.warnings && !peekOnly) {
      for (const ev of tierEvals) {
        if (ev.skipped || ev.banned) continue;
        const newCurrent = ev.current + cost;
        const percent = newCurrent / ev.max;
        await this._checkQuotaWarnings(
          ctx,
          storage,
          ev.tierName,
          ev.key,
          newCurrent,
          ev.max,
          percent,
          ev.windowMs,
        );
      }
    }

    // Build the result from the most-consumed tier
    const activeTiers = tierEvals.filter((e) => !e.skipped && !e.banned);
    const result = this._buildAllowedResult(breakdown, false, activeTiers);

    // Fire onPass hook
    if (this.config.onPass && !peekOnly) {
      await this.config.onPass(ctx, result);
    }

    return result;
  }

  // ── Ban Management ────────────────────────────────────────────────────────

  private async _isBanned(
    storage: IStorageEngine,
    tier: string,
    key: string,
  ): Promise<boolean> {
    const rec = await storage.get<BanRecord>(
      NS_BANS,
      banId(this.name, tier, key),
    );
    if (!rec) return false;
    if (rec.expiresAt <= Date.now()) {
      // Ban expired — clean up
      await storage.delete(NS_BANS, banId(this.name, tier, key));

      // Fire onUnban hook
      if (this.config.penalty?.onUnban) {
        await this.config.penalty.onUnban(key, tier);
      }

      return false;
    }
    return true;
  }

  private async _recordViolation(
    storage: IStorageEngine,
    tier: string,
    key: string,
  ): Promise<{ banned: boolean; banDurationMs: number }> {
    const penalty = this.config.penalty!;
    const vid = violationId(this.name, tier, key);
    const penaltyWindowMs = parseWindow(penalty.penaltyWindow ?? "5m");
    const now = Date.now();
    const cutoff = now - penaltyWindowMs;

    // Load existing violations
    let rec = await storage.get<ViolationRecord>(NS_VIOLATIONS, vid);
    let timestamps = rec?.timestamps ?? [];

    // Prune old violations
    timestamps = timestamps.filter((ts) => ts > cutoff);

    // Add new violation
    timestamps.push(now);
    await storage.save(NS_VIOLATIONS, vid, {
      timestamps,
      createdAt: now + penaltyWindowMs,
    });

    // Check threshold
    if (timestamps.length >= penalty.threshold) {
      const banDurationMs = parseWindow(penalty.banDuration ?? "15m");
      const banRecord: BanRecord = {
        expiresAt: now + banDurationMs,
        tier,
        key,
      };
      await storage.save(NS_BANS, banId(this.name, tier, key), {
        ...banRecord,
        createdAt: now + banDurationMs,
      });

      // Clear violations after ban
      await storage.delete(NS_VIOLATIONS, vid);

      // Fire onBan hook
      if (penalty.onBan) {
        await penalty.onBan(key, tier, timestamps.length);
      }

      // EventBus emission
      OqronEventBus.emit(
        "ratelimit:banned",
        this.name,
        tier,
        key,
        banDurationMs,
      );

      return { banned: true, banDurationMs };
    }
    return { banned: false, banDurationMs: 0 };
  }

  // ── Quota Warning Checks ──────────────────────────────────────────────────

  private async _checkQuotaWarnings(
    ctx: TContext,
    storage: IStorageEngine,
    tier: string,
    key: string,
    current: number,
    max: number,
    percent: number,
    windowMs: number,
  ): Promise<void> {
    if (!this.config.warnings) return;

    const windowId = Math.floor(Date.now() / windowMs);

    for (const [thresholdStr, handler] of Object.entries(
      this.config.warnings.thresholds,
    )) {
      const threshold = Number(thresholdStr);
      if (percent < threshold) continue;

      // Check if already fired this window
      const wid = warningId(this.name, tier, key, threshold);
      const existing = await storage.get<WarningFired>(NS_WARNINGS, wid);
      if (existing && existing.windowId === windowId) continue;

      // Fire the warning
      await storage.save(NS_WARNINGS, wid, {
        firedAt: Date.now(),
        windowId,
        createdAt: Date.now() + windowMs,
      });
      await handler(ctx, { tier, key, current, max, percent });

      // EventBus emission
      OqronEventBus.emit(
        "ratelimit:warning",
        this.name,
        tier,
        key,
        percent,
      );
    }
  }

  // ── Result Builders ───────────────────────────────────────────────────────

  private _buildSkippedResult(): RateLimitResult {
    const result: RateLimitResult = {
      allowed: true,
      wouldBlock: false,
      tier: null,
      current: 0,
      limit: 0,
      remaining: 0,
      resetMs: 0,
      retryAfterSecs: 0,
      retryAfter: new Date(),
      banned: false,
      skipped: true,
      instanceDisabled: false,
      passthrough: false,
      breakdown: [],
      toHeaders: () => buildHeaders(result),
    };
    return result;
  }

  /**
   * Build a result for when the instance is disabled.
   * @param block - if true, deny the request; if false, allow it.
   */
  private _buildDisabledResult(block: boolean): RateLimitResult {
    const result: RateLimitResult = {
      allowed: !block,
      wouldBlock: block,
      tier: null,
      current: 0,
      limit: 0,
      remaining: 0,
      resetMs: 0,
      retryAfterSecs: 0,
      retryAfter: new Date(),
      banned: false,
      skipped: !block,
      instanceDisabled: true,
      passthrough: false,
      breakdown: [],
      toHeaders: () => buildHeaders(result),
    };
    return result;
  }

  private _buildAllowedResult(
    breakdown: TierBreakdown[],
    isFailOpen: boolean,
    activeTiers?: Array<{
      tierName: string;
      current: number;
      max: number;
      resetMs: number;
    }>,
  ): RateLimitResult {
    // Use the most-consumed tier for the top-level stats
    let limit = 0;
    let remaining = 0;
    let resetMs = 0;
    let current = 0;

    if (activeTiers && activeTiers.length > 0) {
      // Find the tier with the highest usage percentage
      let highestPercent = 0;
      for (const t of activeTiers) {
        const pct = t.max > 0 ? t.current / t.max : 0;
        if (pct >= highestPercent) {
          highestPercent = pct;
          limit = t.max;
          current = t.current;
          remaining = Math.max(0, t.max - t.current);
          resetMs = t.resetMs;
        }
      }
    }

    const result: RateLimitResult = {
      allowed: true,
      wouldBlock: false,
      tier: null,
      current,
      limit,
      remaining,
      resetMs,
      retryAfterSecs: 0,
      retryAfter: new Date(),
      banned: false,
      skipped: isFailOpen,
      instanceDisabled: false,
      passthrough: false,
      breakdown,
      toHeaders: () => buildHeaders(result),
    };
    return result;
  }

  // ── Admin APIs ────────────────────────────────────────────────────────────

  async reset(adminKey: string): Promise<void> {
    const { tier, key } = parseAdminKey(adminKey);
    const storage = this.getStorage();

    // Find the tier config to get the window
    const tierConfig = this.config.tiers.find((t) => t.name === tier);
    if (!tierConfig) return;

    const windowMs = parseWindow(tierConfig.window);
    const storageKey = dataKey(this.name, tier, key);

    // Clear algorithm data — save empty state based on algorithm type
    const algo = this.config.algorithm ?? "sliding-window";
    switch (algo) {
      case "sliding-window":
        await storage.save("ratelimit:sliding", storageKey, { entries: [] });
        break;
      case "token-bucket":
        await storage.save("ratelimit:bucket", storageKey, {
          tokens: tierConfig.max,
          lastRefillAt: Date.now(),
        });
        break;
      case "fixed-window":
        await storage.save("ratelimit:fixed", storageKey, {
          windowId: Math.floor(Date.now() / windowMs),
          count: 0,
        });
        break;
    }

    // Clear violations
    await storage.delete(
      NS_VIOLATIONS,
      violationId(this.name, tier, key),
    );
  }

  async getStatus(adminKey: string): Promise<RateLimitKeyStatus | null> {
    const { tier, key } = parseAdminKey(adminKey);
    const storage = this.getStorage();

    const tierConfig = this.config.tiers.find((t) => t.name === tier);
    if (!tierConfig) return null;

    const windowMs = parseWindow(tierConfig.window);
    const storageKey = dataKey(this.name, tier, key);

    // Get current usage
    const overrideRec = await storage.get<OverrideRecord>(
      NS_OVERRIDES,
      overrideId(this.name, tier, key),
    );
    const effectiveMax = overrideRec?.max ?? tierConfig.max;

    const peekResult = await this.algorithm.peek(
      storage,
      storageKey,
      effectiveMax,
      windowMs,
    );

    // Get ban status
    const banRec = await storage.get<BanRecord>(
      NS_BANS,
      banId(this.name, tier, key),
    );
    const banned = banRec ? banRec.expiresAt > Date.now() : false;

    // Get violations
    const violRec = await storage.get<ViolationRecord>(
      NS_VIOLATIONS,
      violationId(this.name, tier, key),
    );
    const penaltyWindowMs = this.config.penalty
      ? parseWindow(this.config.penalty.penaltyWindow ?? "5m")
      : 0;
    const cutoff = Date.now() - penaltyWindowMs;
    const activeViolations = violRec
      ? violRec.timestamps.filter((ts) => ts > cutoff).length
      : 0;

    return {
      key: adminKey,
      tier,
      current: peekResult.current,
      max: effectiveMax,
      remaining: Math.max(0, effectiveMax - peekResult.current),
      resetAt: new Date(Date.now() + peekResult.resetMs),
      override: overrideRec ?? undefined,
      banned,
      banExpiresAt: banned && banRec ? new Date(banRec.expiresAt) : undefined,
      violations: activeViolations,
    };
  }

  async setOverride(
    adminKey: string,
    override: { max: number },
  ): Promise<void> {
    const { tier, key } = parseAdminKey(adminKey);
    const storage = this.getStorage();
    await storage.save(
      NS_OVERRIDES,
      overrideId(this.name, tier, key),
      { ...override, tier, key },
    );

    // EventBus emission
    OqronEventBus.emit(
      "ratelimit:override",
      this.name,
      adminKey,
      override,
    );
  }

  async clearOverride(adminKey: string): Promise<void> {
    const { tier, key } = parseAdminKey(adminKey);
    const storage = this.getStorage();
    await storage.delete(
      NS_OVERRIDES,
      overrideId(this.name, tier, key),
    );
  }

  async ban(adminKey: string, duration?: WindowDuration): Promise<void> {
    const { tier, key } = parseAdminKey(adminKey);
    const storage = this.getStorage();
    const banDurationMs = parseWindow(duration ?? "1h");

    const banRecord: BanRecord = {
      expiresAt: Date.now() + banDurationMs,
      tier,
      key,
    };
    await storage.save(NS_BANS, banId(this.name, tier, key), banRecord);

    OqronEventBus.emit(
      "ratelimit:banned",
      this.name,
      tier,
      key,
      banDurationMs,
    );
  }

  async unban(adminKey: string): Promise<void> {
    const { tier, key } = parseAdminKey(adminKey);
    const storage = this.getStorage();
    await storage.delete(NS_BANS, banId(this.name, tier, key));

    if (this.config.penalty?.onUnban) {
      await this.config.penalty.onUnban(key, tier);
    }
  }

  // ── Snapshot Export ──────────────────────────────────────────────────────

  async snapshot(): Promise<RateLimitSnapshot> {
    const storage = this.getStorage();

    // Load instance record
    const instanceRecord = await storage.get<RateLimitInstanceRecord>(
      "ratelimit_instances",
      this.name,
    );

    // Load stats
    const stats = await storage.get<RateLimitStats>(
      "ratelimit_stats",
      this.name,
    );

    // Collect active bans
    const activeBans: Array<{ tier: string; key: string; expiresAt: number }> = [];
    const banRecords = await storage.list<BanRecord>(NS_BANS, {});
    const now = Date.now();
    for (const ban of banRecords) {
      if (ban.expiresAt > now) {
        activeBans.push({
          tier: ban.tier,
          key: ban.key,
          expiresAt: ban.expiresAt,
        });
      }
    }

    // Collect active overrides
    const activeOverrides: Array<{ tier: string; key: string; max: number }> = [];
    const overrideRecords = await storage.list<OverrideRecord & { tier?: string; key?: string }>(NS_OVERRIDES, {});
    for (const ovr of overrideRecords) {
      if (ovr.max && ovr.tier && ovr.key) {
        activeOverrides.push({
          tier: ovr.tier,
          key: ovr.key,
          max: ovr.max,
        });
      }
    }

    return {
      name: this.name,
      algorithm: this.config.algorithm ?? "sliding-window",
      instanceRecord: instanceRecord ?? null,
      stats: stats ?? null,
      activeBans,
      activeOverrides,
      exportedAt: new Date(),
    };
  }

  // ── Telemetry: Stats Accumulation ──────────────────────────────────────

  private async _updateStats(
    storage: IStorageEngine,
    result: RateLimitResult,
  ): Promise<void> {
    const existing = await storage.get<RateLimitStats>(
      "ratelimit_stats",
      this.name,
    );
    const stats: RateLimitStats = existing ?? {
      name: this.name,
      totalChecks: 0,
      totalAllowed: 0,
      totalBlocked: 0,
      totalBanned: 0,
      totalSkipped: 0,
      lastCheckAt: 0,
      lastBlockAt: null,
      tierStats: {},
    };

    stats.totalChecks++;
    stats.lastCheckAt = Date.now();

    if (result.skipped) {
      stats.totalSkipped++;
    } else if (result.allowed) {
      stats.totalAllowed++;
    } else {
      stats.totalBlocked++;
      stats.lastBlockAt = Date.now();
      if (result.banned) {
        stats.totalBanned++;
      }
    }

    // Update per-tier stats from breakdown
    if (result.breakdown) {
      for (const tb of result.breakdown) {
        if (tb.skipped) continue;
        if (!stats.tierStats[tb.name]) {
          stats.tierStats[tb.name] = { checks: 0, blocks: 0, allowed: 0 };
        }
        const ts = stats.tierStats[tb.name];
        ts.checks++;
        if (tb.allowed) {
          ts.allowed++;
        } else {
          ts.blocks++;
        }
      }
    }

    await storage.save("ratelimit_stats", this.name, stats);
  }

  // ── Telemetry: Block Event Audit Trail ──────────────────────────────────

  private async _writeBlockEvent(
    storage: IStorageEngine,
    result: RateLimitResult,
    cost: number,
  ): Promise<void> {
    const event = {
      id: randomUUID(),
      limiterName: this.name,
      tier: result.tier ?? "unknown",
      key: "",
      type: result.banned ? "banned" : "blocked",
      current: result.current,
      max: result.limit,
      cost,
      banned: result.banned,
      dryRun: this.dryRun,
      timestamp: Date.now(),
      createdAt: new Date(),
    };

    // Extract the key from the first non-skipped, non-allowed tier in breakdown
    if (result.breakdown) {
      const blockingEntry = result.breakdown.find(
        (b) => !b.skipped && !b.allowed,
      );
      if (blockingEntry) {
        event.key = blockingEntry.key;
      }
    }

    await storage.save("ratelimit_events", event.id, event);
  }
}
