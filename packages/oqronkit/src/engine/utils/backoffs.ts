/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  OqronKit — Backoff Strategies
 *
 *  Built-in fixed, exponential, and custom backoff calculators for retry logic
 *  across all OqronKit engine modules.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

export interface BackoffOptions {
  type: "fixed" | "exponential" | "custom";
  delay: number;
  /**
   * F7: Custom backoff function.
   * Only used when `type` is `"custom"`.
   * Receives the attempt number (1-based) and base delay, returns delay in ms.
   *
   * @example
   * ```ts
   * backoffFn: (attempt, baseDelay) => baseDelay * attempt * attempt // Quadratic
   * ```
   */
  backoffFn?: (attempt: number, baseDelay: number) => number;
}

type BackoffStrategy = (attemptsMade: number) => number;

const builtinStrategies: Record<string, (delay: number) => BackoffStrategy> = {
  /**
   * Fixed delay: always waits the same amount of time.
   */
  fixed: (delay: number) => () => delay,

  /**
   * Exponential backoff: delay * 2^(attempt - 1).
   * Attempt 1 → delay, Attempt 2 → delay*2, Attempt 3 → delay*4, ...
   */
  exponential: (delay: number) => (attemptsMade: number) =>
    Math.round(2 ** (attemptsMade - 1) * delay),
};

/**
 * Normalize raw backoff input (number or object) into a BackoffOptions.
 */
export function normalizeBackoff(
  backoff?: number | BackoffOptions,
): BackoffOptions | undefined {
  if (typeof backoff === "number") {
    return { type: "fixed", delay: backoff };
  }
  return backoff;
}

/**
 * Calculate the delay for the next retry attempt.
 *
 * @param backoff - The backoff configuration
 * @param attemptsMade - Number of attempts completed so far (1-based)
 * @param maxDelay - Optional ceiling to cap exponential growth
 * @returns Delay in milliseconds
 */
export function calculateBackoff(
  backoff: BackoffOptions | undefined,
  attemptsMade: number,
  maxDelay?: number,
): number {
  if (!backoff) return 0;

  let delay: number;

  // F7: Custom backoff strategy
  if (backoff.type === "custom") {
    if (!backoff.backoffFn) {
      throw new Error(
        `[OqronKit] Custom backoff strategy requires a "backoffFn" function.`,
      );
    }
    delay = backoff.backoffFn(attemptsMade, backoff.delay);
  } else {
    const strategyFactory = builtinStrategies[backoff.type];
    if (!strategyFactory) {
      throw new Error(
        `[OqronKit] Unknown backoff strategy "${backoff.type}". ` +
          `Supported: "fixed", "exponential", "custom".`,
      );
    }

    const strategy = strategyFactory(backoff.delay);
    delay = strategy(attemptsMade);
  }

  // Cap at maxDelay if specified
  if (maxDelay && delay > maxDelay) {
    return maxDelay;
  }

  return delay;
}
