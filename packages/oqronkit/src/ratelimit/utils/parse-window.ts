/**
 * Parses human-readable window duration strings into milliseconds.
 *
 * Supported units:
 *   s — seconds
 *   m — minutes
 *   h — hours
 *   d — days
 *
 * @example
 * parseWindow('30s')  // 30_000
 * parseWindow('1m')   // 60_000
 * parseWindow('1h')   // 3_600_000
 * parseWindow('1d')   // 86_400_000
 */

const UNITS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseWindow(window: string): number {
  const match = window.match(/^(\d+)(s|m|h|d)$/);
  if (!match) {
    throw new Error(
      `[OqronKit:RateLimit] Invalid window format: "${window}". Use: 30s, 1m, 1h, 1d`,
    );
  }
  const amount = parseInt(match[1], 10);
  if (amount <= 0) {
    throw new Error(
      `[OqronKit:RateLimit] Invalid window duration: "${window}". Duration must be greater than zero.`,
    );
  }
  return amount * UNITS[match[2]];
}
