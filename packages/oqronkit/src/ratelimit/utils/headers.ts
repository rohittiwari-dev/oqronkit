import type { RateLimitResult } from "../types.js";

/**
 * Generate standard HTTP rate limit headers.
 * Conforms to RFC 6585 and draft-ietf-httpapi-ratelimit-headers.
 *
 * Headers produced:
 *   X-RateLimit-Limit      — Maximum allowed requests
 *   X-RateLimit-Remaining  — Remaining requests before block
 *   X-RateLimit-Reset      — Seconds until window resets
 *   Retry-After            — (only when blocked) seconds to wait
 *   X-RateLimit-Policy     — Tier-specific policy descriptor
 */
export function buildHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(Math.max(0, result.remaining)),
    "X-RateLimit-Reset": String(Math.ceil(result.resetMs / 1000)),
  };

  if (!result.allowed || result.wouldBlock) {
    headers["Retry-After"] = String(result.retryAfterSecs);
  }

  if (result.tier) {
    headers["X-RateLimit-Policy"] =
      `${result.limit};w=${Math.ceil(result.resetMs / 1000)};name="${result.tier}"`;
  }

  return headers;
}
