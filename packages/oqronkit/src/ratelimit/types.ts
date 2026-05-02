// ── Rate Limit Module — Complete Type System ────────────────────────────────
// Defines all interfaces, configs, and result types for the distributed
// multi-tier rate limiter.

// ── Primitives ──────────────────────────────────────────────────────────────

export type RateLimitAlgorithm =
  | "sliding-window"
  | "token-bucket"
  | "fixed-window";

/**
 * Human-readable duration string.
 * Supported formats: '30s', '1m', '5m', '1h', '6h', '1d', '30d'
 */
export type WindowDuration = string;

// ── Algorithm Internal Interface ────────────────────────────────────────────

export interface AlgorithmResult {
  /** Whether the consumption was allowed. */
  allowed: boolean;
  /** Current consumption count in the window after this operation. */
  current: number;
  /** Milliseconds until the window resets. */
  resetMs: number;
}

export interface IRateLimitAlgorithm {
  /** Check and consume tokens. */
  consume(
    storage: import("../engine/types/engine.js").IStorageEngine,
    storageKey: string,
    max: number,
    windowMs: number,
    cost: number,
  ): Promise<AlgorithmResult>;

  /** Peek at current usage without consuming tokens. Read-only. */
  peek(
    storage: import("../engine/types/engine.js").IStorageEngine,
    storageKey: string,
    max: number,
    windowMs: number,
  ): Promise<{ current: number; resetMs: number }>;
}

// ── Tier Definition ─────────────────────────────────────────────────────────

export interface RateLimitTier<TContext = any> {
  /** Unique tier name. Used in results, admin APIs, and storage keys. */
  name: string;

  /**
   * Extract the rate-limit key from context.
   * Return null/undefined to skip this tier entirely.
   */
  key: (ctx: TContext) => string | undefined | null;

  /** Maximum requests allowed in this window. */
  max: number;

  /** Window duration (human-readable). */
  window: WindowDuration;

  /**
   * Conditional evaluation. If returns false, tier is skipped entirely.
   * Use for: skip per-user tier on anonymous requests.
   */
  enabled?: (ctx: TContext) => boolean;
}

// ── Penalty Escalation ──────────────────────────────────────────────────────

export interface PenaltyConfig {
  /**
   * After this many rate-limit violations within penaltyWindow,
   * ban the key.
   */
  threshold: number;

  /** Window in which violations are counted. @default '5m' */
  penaltyWindow?: WindowDuration;

  /** Duration of the ban once triggered. @default '15m' */
  banDuration?: WindowDuration;

  /** Hook called when a ban is triggered. */
  onBan?: (
    key: string,
    tier: string,
    violations: number,
  ) => void | Promise<void>;

  /** Hook called when a ban expires. */
  onUnban?: (key: string, tier: string) => void | Promise<void>;
}

// ── Quota Warning Thresholds ────────────────────────────────────────────────

export interface QuotaWarnings<TContext = any> {
  /**
   * Percentage thresholds (0-1). When usage crosses a threshold, the
   * corresponding hook fires. Each threshold fires at most once per window.
   * @example { 0.8: onWarning, 0.95: onCritical }
   */
  thresholds: Record<
    number,
    (ctx: TContext, usage: QuotaUsage) => void | Promise<void>
  >;
}

export interface QuotaUsage {
  tier: string;
  key: string;
  current: number;
  max: number;
  percent: number;
}

// ── Check Options ───────────────────────────────────────────────────────────

export interface CheckOptions {
  /**
   * Number of tokens to consume. @default 1
   * Use for weighted consumption: bulk API calls cost more.
   */
  cost?: number;
}

// ── Full Config ─────────────────────────────────────────────────────────────

export interface RateLimitConfig<TContext = any> {
  /** Unique limiter name (storage namespace key). */
  name: string;

  /** Algorithm. @default "sliding-window" */
  algorithm?: RateLimitAlgorithm;

  /** Multi-tier definitions. Evaluated in order — first block wins. */
  tiers: RateLimitTier<TContext>[];

  // ── Hooks ───────────────────────────────────────────────────────────────

  /** Called when any tier blocks. Return custom error payload. */
  onLimit?: (ctx: TContext, result: RateLimitResult) => any | Promise<any>;

  /** Called when all tiers pass (request allowed). */
  onPass?: (ctx: TContext, result: RateLimitResult) => void | Promise<void>;

  // ── Penalty Escalation ──────────────────────────────────────────────────

  /**
   * Penalty escalation: auto-ban after repeated violations.
   * If omitted, no escalation — just standard rate limiting.
   */
  penalty?: PenaltyConfig;

  // ── Quota Warnings ──────────────────────────────────────────────────────

  /** Threshold-based warnings at usage percentages. */
  warnings?: QuotaWarnings<TContext>;

  // ── Whitelist / Skip ────────────────────────────────────────────────────

  /**
   * Global skip condition. If returns true, ALL tiers are bypassed.
   * Use for: internal services, health checks, admin tokens.
   */
  skip?: (ctx: TContext) => boolean | Promise<boolean>;

  // ── Dry Run ─────────────────────────────────────────────────────────────

  /**
   * If true, evaluate and log blocks but never actually block.
   * result.allowed is always true, but result.wouldBlock indicates
   * what WOULD have been blocked. Essential for tuning in production.
   * @default false
   */
  dryRun?: boolean;

  // ── Jitter ──────────────────────────────────────────────────────────────

  /**
   * Random jitter added to retryAfterSecs to prevent thundering herd.
   * Value is a fraction (0-1) of the retry duration. 0.1 = ±10%.
   * @default 0.1
   */
  jitter?: number;

  // ── Token Bucket Specific ───────────────────────────────────────────────

  /** Tokens refilled per interval (token-bucket only). */
  refillRate?: number;

  /** Refill interval in ms (token-bucket only). */
  refillIntervalMs?: number;

  // ── Resilience ──────────────────────────────────────────────────────────

  /**
   * If true, allow requests when storage is unavailable.
   * @default false (fail-closed)
   */
  failOpen?: boolean;

  /** Tags for observability. */
  tags?: string[];

  // ── Management Plane ──────────────────────────────────────────────────

  /**
   * Behavior when this instance is disabled from the dashboard.
   * - `"skip"` — allow all requests (bypasses all tiers)
   * - `"block"` — deny all requests immediately
   * - `"passthrough"` — allow all but log as passthrough (telemetry only)
   * @default "skip"
   */
  disabledBehavior?: "skip" | "block" | "passthrough";

  /** Enable adaptive threshold suggestions. @default false */
  adaptive?: boolean;

  /** Circuit breaker: auto-increase max after N consecutive full-utilization windows. */
  circuitBreaker?: {
    consecutiveFullWindows: number;
    burstMultiplier: number;
    cooldownWindow: WindowDuration;
  };

  /** Other limiters this one depends on. check() only runs if all deps passed. */
  dependsOn?: string[];

  /** Auto cost estimator — calculates cost from request context */
  costEstimator?: (ctx: TContext) => number;
}

// ── Per-Tier Breakdown ──────────────────────────────────────────────────────

export interface TierBreakdown {
  /** Tier name. */
  name: string;
  /** Resolved key for this tier. */
  key: string;
  /** Current count in this tier's window. */
  current: number;
  /** Max allowed (may be overridden). */
  max: number;
  /** Remaining before block. */
  remaining: number;
  /** Whether this tier individually allows. */
  allowed: boolean;
  /** Whether this tier was skipped (enabled=false or key=null). */
  skipped: boolean;
}

// ── Result ──────────────────────────────────────────────────────────────────

export interface RateLimitResult {
  /** Whether the request was allowed. */
  allowed: boolean;

  /**
   * In dry-run mode, `allowed` is always true but `wouldBlock`
   * tells you what would have happened in enforcement mode.
   */
  wouldBlock: boolean;

  /** Which tier triggered the block (null if allowed). */
  tier: string | null;

  /** Current count in the blocking tier's window. */
  current: number;

  /** Max allowed in the blocking tier. */
  limit: number;

  /** Remaining before hitting the limit. */
  remaining: number;

  /** Time until window resets (ms). */
  resetMs: number;

  /** Retry-After in seconds (with jitter applied). */
  retryAfterSecs: number;

  /** Date when limit resets. */
  retryAfter: Date;

  /** Whether the key is currently banned (penalty escalation). */
  banned: boolean;

  /** Custom error payload from onLimit hook. */
  error?: any;

  /** Whether the request was skipped via skip() function. */
  skipped: boolean;

  /** Whether the instance was disabled when this check ran */
  instanceDisabled: boolean;

  /** Passthrough mode: check ran as telemetry only, no enforcement */
  passthrough: boolean;

  /** Per-tier breakdown of all evaluated tiers. */
  breakdown: TierBreakdown[];

  /**
   * Generate standard HTTP rate limit headers.
   * Returns: X-RateLimit-Limit, X-RateLimit-Remaining,
   *          X-RateLimit-Reset, Retry-After, RateLimit-Policy
   */
  toHeaders(): Record<string, string>;
}

// ── Admin Types ─────────────────────────────────────────────────────────────

export interface RateLimitKeyStatus {
  key: string;
  tier: string;
  current: number;
  max: number;
  remaining: number;
  resetAt: Date;
  override?: { max: number };
  banned: boolean;
  banExpiresAt?: Date;
  violations: number;
}

// ── IRateLimiter Handle ─────────────────────────────────────────────────────

export interface IRateLimiter<TContext = any> {
  readonly name: string;

  /** Check and consume tokens. First tier to block stops evaluation. */
  check(ctx: TContext, opts?: CheckOptions): Promise<RateLimitResult>;

  /** Peek at status without consuming tokens. Read-only. Cost defaults to 0 (current state). */
  peek(ctx: TContext, cost?: number): Promise<RateLimitResult>;

  /** Reset all counters for a key. Format: 'tierName:resolvedKey' */
  reset(key: string): Promise<void>;

  /** Get current status for a specific key. */
  getStatus(key: string): Promise<RateLimitKeyStatus | null>;

  /** Set per-key override (VIP boost). Replaces tier max for this key. */
  setOverride(key: string, override: { max: number }): Promise<void>;

  /** Remove per-key override, revert to tier defaults. */
  clearOverride(key: string): Promise<void>;

  /** Manually ban a key for a specific duration. */
  ban(key: string, duration?: WindowDuration): Promise<void>;

  /** Manually unban a key. */
  unban(key: string): Promise<void>;

  /**
   * Batch check multiple contexts. Returns results in order.
   * Stops at first block if `stopOnBlock` is true (default).
   * This is sequential, not all-or-none: earlier allowed contexts consume quota
   * even if a later context is blocked.
   */
  checkMany(
    contexts: TContext[],
    opts?: CheckOptions & { stopOnBlock?: boolean },
  ): Promise<RateLimitResult[]>;

  /** Export a full snapshot of all keys, bans, overrides for debugging/migration */
  snapshot(): Promise<RateLimitSnapshot>;
}

// ── Instance Management Types ───────────────────────────────────────────────

export interface RateLimitInstanceRecord {
  name: string;
  algorithm: RateLimitAlgorithm;
  tierNames: string[];
  dryRun: boolean;
  failOpen: boolean;
  enabled: boolean;
  disabledBehavior: "skip" | "block" | "passthrough";
  createdAt: Date;
  tags: string[];
}

export interface RateLimitStats {
  name: string;
  totalChecks: number;
  totalAllowed: number;
  totalBlocked: number;
  totalBanned: number;
  totalSkipped: number;
  lastCheckAt: number;
  lastBlockAt: number | null;
  tierStats: Record<
    string,
    {
      checks: number;
      blocks: number;
      allowed: number;
    }
  >;

  // ── Adaptive Tracking (G1) ────────────────────────────────────────────
  /** Rolling usage-% samples per tier (last N windows). Only populated when adaptive=true. */
  usageSamples?: Record<string, number[]>;
  /** Timestamp of last suggestion emission per tier. Prevents spam. */
  lastSuggestionAt?: Record<string, number>;
}

export interface RateLimitEvent {
  id: string;
  limiterName: string;
  tier: string;
  key: string;
  type:
    | "blocked"
    | "banned"
    | "unbanned"
    | "override-set"
    | "override-cleared";
  current: number;
  max: number;
  cost: number;
  banned: boolean;
  dryRun: boolean;
  timestamp: number;
  createdAt: Date;
}

export interface RateLimitSnapshot {
  name: string;
  algorithm: RateLimitAlgorithm;
  instanceRecord: RateLimitInstanceRecord | null;
  stats: RateLimitStats | null;
  activeBans: Array<{ tier: string; key: string; expiresAt: number }>;
  activeOverrides: Array<{ tier: string; key: string; max: number }>;
  exportedAt: Date;
}
