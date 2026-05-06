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
   * Exponential backoff with jitter: delay * 2^(attempt - 1) * (0.8..1.2).
   * Attempt 1 → ~delay, Attempt 2 → ~delay*2, Attempt 3 → ~delay*4, ...
   * The ±20% random jitter prevents thundering herds when many jobs retry simultaneously.
   */
  exponential: (delay: number) => (attemptsMade: number) =>
    Math.round(2 ** (attemptsMade - 1) * delay * (0.8 + Math.random() * 0.4)),
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
  if (!Number.isFinite(backoff.delay) || backoff.delay <= 0) {
    throw new Error(
      "[OqronKit] Backoff delay must be a positive finite number.",
    );
  }
  if (maxDelay !== undefined && (!Number.isFinite(maxDelay) || maxDelay <= 0)) {
    throw new Error("[OqronKit] maxDelay must be a positive finite number.");
  }
  const safeAttemptsMade = Math.max(1, Math.floor(attemptsMade));

  let delay: number;

  // F7: Custom backoff strategy
  if (backoff.type === "custom") {
    if (!backoff.backoffFn) {
      throw new Error(
        `[OqronKit] Custom backoff strategy requires a "backoffFn" function.`,
      );
    }
    delay = backoff.backoffFn(safeAttemptsMade, backoff.delay);
  } else {
    const strategyFactory = builtinStrategies[backoff.type];
    if (!strategyFactory) {
      throw new Error(
        `[OqronKit] Unknown backoff strategy "${backoff.type}". ` +
          `Supported: "fixed", "exponential", "custom".`,
      );
    }

    const strategy = strategyFactory(backoff.delay);
    delay = strategy(safeAttemptsMade);
  }

  if (!Number.isFinite(delay) || delay <= 0) {
    throw new Error("[OqronKit] Backoff strategy produced an invalid delay.");
  }

  // Cap at maxDelay if specified
  if (maxDelay && delay > maxDelay) {
    return maxDelay;
  }

  return delay;
}
