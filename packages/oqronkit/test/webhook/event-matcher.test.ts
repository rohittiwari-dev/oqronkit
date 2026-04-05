import { describe, expect, it } from "vitest";
import { matchesEvent } from "../../src/webhook/event-matcher.js";

describe("Webhook Event Matcher", () => {
  // ── Exact match ─────────────────────────────────────────────────────────

  it("should match exact events", () => {
    expect(matchesEvent("user.created", ["user.created"])).toBe(true);
    expect(matchesEvent("user.created", ["user.updated"])).toBe(false);
  });

  it("should match multi-segment exact events", () => {
    expect(
      matchesEvent("user.profile.updated", ["user.profile.updated"]),
    ).toBe(true);
  });

  // ── Single-segment wildcard (*) ─────────────────────────────────────────

  it("* should match a SINGLE segment only (no dots)", () => {
    expect(matchesEvent("user.created", ["user.*"])).toBe(true);
    expect(matchesEvent("user.updated", ["user.*"])).toBe(true);
    expect(matchesEvent("org.created", ["user.*"])).toBe(false);
  });

  it("* should NOT cross dot boundaries", () => {
    expect(matchesEvent("user.profile.updated", ["user.*"])).toBe(false);
    expect(matchesEvent("user.activity.login", ["user.*"])).toBe(false);
  });

  // ── Multi-segment wildcard (**) ─────────────────────────────────────────

  it("** should match ONE OR MORE segments", () => {
    expect(matchesEvent("user.created", ["user.**"])).toBe(true);
    expect(matchesEvent("user.profile.updated", ["user.**"])).toBe(true);
    expect(matchesEvent("user.activity.login.failed", ["user.**"])).toBe(true);
  });

  it("** should not match a different prefix", () => {
    expect(matchesEvent("org.user.created", ["user.**"])).toBe(false);
  });

  // ── Prefix wildcards ──────────────────────────────────────────────────

  it("should handle prefix wildcards with *", () => {
    expect(matchesEvent("org.user.created", ["*.user.created"])).toBe(true);
    expect(
      matchesEvent("tenant1.user.created", ["*.user.created"]),
    ).toBe(true);
    expect(matchesEvent("org.admin.created", ["*.user.created"])).toBe(false);
  });

  // ── Middle wildcards ──────────────────────────────────────────────────

  it("should handle middle wildcards with *", () => {
    expect(matchesEvent("user.123.created", ["user.*.created"])).toBe(true);
    expect(matchesEvent("user.abc.created", ["user.*.created"])).toBe(true);
    // * does NOT cross dots — this has 2 middle segments
    expect(
      matchesEvent("user.profile.123.created", ["user.*.created"]),
    ).toBe(false);
  });

  it("should handle middle wildcards with **", () => {
    expect(
      matchesEvent("user.profile.123.created", ["user.**.created"]),
    ).toBe(true);
    expect(
      matchesEvent("user.a.b.c.created", ["user.**.created"]),
    ).toBe(true);
  });

  // ── Bare catch-all ────────────────────────────────────────────────────

  it("should handle bare * as catch-all", () => {
    expect(matchesEvent("anything", ["*"])).toBe(true);
    expect(matchesEvent("user.created", ["*"])).toBe(true);
    expect(matchesEvent("a.b.c.d", ["*"])).toBe(true);
  });

  it("should handle bare ** as catch-all", () => {
    expect(matchesEvent("anything", ["**"])).toBe(true);
    expect(matchesEvent("user.created", ["**"])).toBe(true);
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  it("should return false for empty patterns", () => {
    expect(matchesEvent("user.created", [])).toBe(false);
  });

  it("should match if ANY pattern in the array matches", () => {
    expect(matchesEvent("user.created", ["org.*", "user.*"])).toBe(true);
    expect(matchesEvent("tenant.created", ["org.*", "user.*"])).toBe(false);
  });

  it("should not match unrelated patterns", () => {
    expect(matchesEvent("payment.completed", ["user.*"])).toBe(false);
    expect(matchesEvent("a.b.c", ["x.y.z"])).toBe(false);
  });

  it("should handle single-segment events", () => {
    expect(matchesEvent("ping", ["ping"])).toBe(true);
    expect(matchesEvent("ping", ["pong"])).toBe(false);
    expect(matchesEvent("ping", ["*"])).toBe(true);
  });
});
