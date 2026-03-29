import { describe, it, expect } from "vitest";
import {
  calculateBackoff,
  normalizeBackoff,
} from "../../src/engine/utils/backoffs.js";

describe("calculateBackoff()", () => {
  it("should return baseDelay for fixed strategy on any attempt", () => {
    const opts = { type: "fixed" as const, delay: 2000 };
    expect(calculateBackoff(opts, 1, 60000)).toBe(2000);
    expect(calculateBackoff(opts, 5, 60000)).toBe(2000);
    expect(calculateBackoff(opts, 100, 60000)).toBe(2000);
  });

  it("should return exponentially growing delays for exponential strategy", () => {
    const opts = { type: "exponential" as const, delay: 1000 };
    const d1 = calculateBackoff(opts, 1, 60000);
    const d2 = calculateBackoff(opts, 2, 60000);
    const d3 = calculateBackoff(opts, 3, 60000);

    expect(d1).toBe(1000); // 1000 * 2^0
    expect(d2).toBe(2000); // 1000 * 2^1
    expect(d3).toBe(4000); // 1000 * 2^2
  });

  it("should cap exponential delay at maxDelay", () => {
    const opts = { type: "exponential" as const, delay: 1000 };
    const d10 = calculateBackoff(opts, 10, 30000);

    // 1000 * 2^9 = 512000, but capped at 30000
    expect(d10).toBe(30000);
  });

  it("should default to baseDelay when using fixed strategy", () => {
    const d = calculateBackoff({ type: "fixed", delay: 1000 }, 2, 60000);
    expect(d).toBe(1000); // fixed always returns baseDelay
  });

  it("should handle attempt=0 gracefully", () => {
    const d = calculateBackoff({ type: "exponential", delay: 1000 }, 0, 60000);
    // 2^(-1) = 0.5 → 500, but minimum should be reasonable
    expect(d).toBeGreaterThanOrEqual(0);
  });
});

describe("normalizeBackoff()", () => {
  it("should convert number to { type: fixed, delay }", () => {
    const result = normalizeBackoff(5000);
    expect(result).toEqual({ type: "fixed", delay: 5000 });
  });

  it("should pass through objects unchanged", () => {
    const input = { type: "exponential" as const, delay: 2000 };
    expect(normalizeBackoff(input)).toEqual(input);
  });
});
