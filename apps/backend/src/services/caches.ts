/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  OqronKit — Cache Module (Service Layer)
 *  Standalone cache instances — NOT triggers. These don't need auto-discovery.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *  cache.create() instantly registers the cache in OqronKit's global registry,
 *  making it visible to the admin API (/admin/caches) without needing to live
 *  in the triggers/ directory.
 *
 *  Features demonstrated:
 *  ✓ L1 (in-memory) + L2 (distributed) tiered caching
 *  ✓ Stale-while-revalidate (SWR)
 *  ✓ Stale-if-error resilience
 *  ✓ Stampede protection (localSingleFlight + clusterLock)
 *  ✓ Negative caching (cache "not found" results)
 *  ✓ Prewarming (background population of hot keys)
 *  ✓ TTL configuration (static and dynamic)
 *  ✓ Lifecycle hooks (onCacheHit, onCacheMiss, onFetchError)
 */

import { cache } from "oqronkit";

// ─────────────────────────────────────────────────────────────────────────────
// 1. USER PROFILE CACHE
//    Frequently accessed user data with SWR and stampede protection.
//    TTL: 5 minutes, SWR window: 1 minute, stale-if-error: 5 minutes
// ─────────────────────────────────────────────────────────────────────────────
type UserProfile = {
  id: string;
  name: string;
  email: string;
  plan: "free" | "pro" | "enterprise";
  avatarUrl: string;
  createdAt: string;
};

export const userProfileCache = cache.create<UserProfile>({
  name: "user-profiles",

  // Primary TTL — entries expire after 5 minutes
  ttlMs: 5 * 60 * 1000,

  // L1: in-process memory tier (up to 1000 entries)
  l1: {
    enabled: true,
    maxItems: 1000,
  },

  // L2: distributed tier via Storage adapter
  l2: {
    enabled: true,
    compression: "gzip",
    circuitBreaker: {
      failuresThreshold: 5,
      resetTimeoutMs: 30_000,
    },
  },

  // Return stale data instantly while refreshing in the background
  staleWhileRevalidateMs: 60_000, // Serve stale up to 1 minute

  // If the fetcher throws, keep serving stale data for 5 minutes
  staleIfErrorMs: 5 * 60 * 1000,

  // Cache "user not found" results for 60 seconds to avoid DB hammering
  negativeCache: {
    enabled: true,
    ttlMs: 60_000,
  },

  // Only one process fetches on cache miss, others wait and share
  stampedeProtection: {
    localSingleFlight: true,
    clusterLock: true,
    lockTtlMs: 10_000,
  },

  // Lifecycle hooks for observability
  hooks: {
    onCacheHit: (key, tier, stale) => {
      if (stale) console.log(`🔄 [cache] SWR hit for ${key} from ${tier}`);
    },
    onCacheMiss: (key) => {
      console.log(`❌ [cache] Miss for ${key} — fetching from DB`);
    },
    onFetchError: (key, error) => {
      console.error(`🔥 [cache] Fetch error for ${key}: ${error.message}`);
    },
  },

  // Global fetcher — called on cache miss
  fetcher: async (key) => {
    // Simulate DB lookup
    console.log(`🔍 [cache] Fetching user profile from DB: ${key}`);
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));

    // Simulate: 90% of users exist, 10% return null (negative cache)
    if (Math.random() < 0.1) return null as unknown as UserProfile;

    return {
      id: key,
      name: `User ${key.slice(-4)}`,
      email: `user-${key.slice(-4)}@example.com`,
      plan: (["free", "pro", "enterprise"] as const)[
        Math.floor(Math.random() * 3)
      ],
      avatarUrl: `https://avatars.example.com/${key}.jpg`,
      createdAt: new Date(
        Date.now() - Math.random() * 365 * 24 * 60 * 60 * 1000,
      ).toISOString(),
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. APPLICATION CONFIG CACHE
//    Short-TTL config cache with prewarming for hot settings.
//    Config rarely changes but is read on every request.
// ─────────────────────────────────────────────────────────────────────────────
type AppConfig = {
  key: string;
  value: unknown;
  updatedAt: string;
};

export const configCache = cache.create<AppConfig>({
  name: "app-config",

  // Short TTL — config can change via admin panel
  ttlMs: 30_000, // 30 seconds

  l1: {
    enabled: true,
    maxItems: 200,
  },

  l2: {
    enabled: true,
  },

  staleWhileRevalidateMs: 30_000,

  stampedeProtection: {
    localSingleFlight: true,
    clusterLock: false, // Config is small, no need for cluster lock
  },

  // Prewarm critical config keys on startup and every 30 seconds
  prewarm: {
    intervalMs: 30_000,
    keys: async () => [
      "feature-flags",
      "rate-limits",
      "maintenance-mode",
      "payment-gateways",
      "notification-channels",
    ],
  },

  fetcher: async (key) => {
    console.log(`⚙️ [cache] Loading config key from DB: ${key}`);
    await new Promise((r) => setTimeout(r, 20));

    return {
      key,
      value: { enabled: true, version: "1.0.0" },
      updatedAt: new Date().toISOString(),
    };
  },
});
