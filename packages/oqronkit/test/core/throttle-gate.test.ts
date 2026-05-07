import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ThrottleGate,
  type ThrottleConfig,
} from "../../src/engine/utils/throttle-gate.js";

describe("ThrottleGate", () => {
  it("returns max when no dispatches recorded", () => {
    const gate = new ThrottleGate({ max: 10, duration: 1000 });
    expect(gate.getAvailable()).toBe(10);
  });

  it("decrements availability after record()", () => {
    const gate = new ThrottleGate({ max: 10, duration: 1000 });
    gate.record(3);
    expect(gate.getAvailable()).toBe(7);
  });

  it("returns 0 when window is exhausted", () => {
    const gate = new ThrottleGate({ max: 5, duration: 1000 });
    gate.record(5);
    expect(gate.getAvailable()).toBe(0);
  });

  it("never returns negative", () => {
    const gate = new ThrottleGate({ max: 3, duration: 1000 });
    gate.record(10); // Over-record
    expect(gate.getAvailable()).toBe(0);
  });

  it("expires timestamps after duration", () => {
    vi.useFakeTimers();
    try {
      const gate = new ThrottleGate({ max: 5, duration: 1000 });
      gate.record(5);
      expect(gate.getAvailable()).toBe(0);

      // Advance time past the window
      vi.advanceTimersByTime(1001);
      expect(gate.getAvailable()).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sliding window partially expires old timestamps", () => {
    vi.useFakeTimers();
    try {
      const gate = new ThrottleGate({ max: 10, duration: 1000 });

      // Record 3 at t=0
      gate.record(3);
      expect(gate.getAvailable()).toBe(7);

      // Advance 600ms, record 4 more
      vi.advanceTimersByTime(600);
      gate.record(4);
      expect(gate.getAvailable()).toBe(3);

      // Advance another 500ms (t=1100) — first 3 expire
      vi.advanceTimersByTime(500);
      expect(gate.getAvailable()).toBe(6); // 10 - 4 remaining

      // Advance another 500ms (t=1600) — all expire
      vi.advanceTimersByTime(500);
      expect(gate.getAvailable()).toBe(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it("record(0) is a no-op", () => {
    const gate = new ThrottleGate({ max: 5, duration: 1000 });
    gate.record(0);
    expect(gate.getAvailable()).toBe(5);
  });

  it("throws on invalid max", () => {
    expect(() => new ThrottleGate({ max: 0, duration: 1000 })).toThrow(
      "max must be a positive",
    );
    expect(() => new ThrottleGate({ max: -1, duration: 1000 })).toThrow(
      "max must be a positive",
    );
  });

  it("throws on invalid duration", () => {
    expect(() => new ThrottleGate({ max: 5, duration: 0 })).toThrow(
      "duration must be a positive",
    );
    expect(() => new ThrottleGate({ max: 5, duration: -100 })).toThrow(
      "duration must be a positive",
    );
  });
});
