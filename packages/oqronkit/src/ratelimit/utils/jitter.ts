/**
 * Apply random jitter to a duration to prevent thundering herd effects.
 *
 * @param durationMs  - The base duration in milliseconds.
 * @param jitterFraction - Fraction of the duration for jitter range.
 *                         0.1 means ±10% of the duration.
 * @returns The jittered duration. Always >= 0.
 *
 * @example
 * applyJitter(60_000, 0.1)  // returns ~54_000 to ~66_000
 */
export function applyJitter(
  durationMs: number,
  jitterFraction: number,
): number {
  if (jitterFraction <= 0 || durationMs <= 0) return durationMs;
  const jitter = durationMs * jitterFraction;
  const result = durationMs + (Math.random() * 2 - 1) * jitter;
  return Math.max(0, result);
}
