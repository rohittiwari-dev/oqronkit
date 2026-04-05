import { describe, expect, it, vi, afterEach } from "vitest";
import {
  deliverWebhook,
  shouldRetryDelivery,
} from "../../src/webhook/delivery.js";

const originalFetch = globalThis.fetch;

function mockFetchResponse(
  status: number,
  body: string,
  headers?: Record<string, string>,
) {
  const encoder = new TextEncoder();
  const buffer = encoder.encode(body).buffer;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers ?? {}),
    body: true, // truthy so the engine enters the body-read branch
    arrayBuffer: vi.fn().mockResolvedValue(buffer),
  };
}

describe("Webhook Delivery Utility", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ── deliverWebhook ────────────────────────────────────────────────────────

  describe("deliverWebhook", () => {
    it("should deliver a POST request and parse response via arrayBuffer", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse(
          200,
          JSON.stringify({ success: true }),
          { "content-type": "application/json" },
        ),
      );

      const result = await deliverWebhook(
        "http://example.com/webhook",
        "POST",
        { "x-test": "true" },
        JSON.stringify({ hello: "world" }),
        5000,
      );

      expect(result.status).toBe(200);
      expect(result.body).toBe(JSON.stringify({ success: true }));
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.headers).toBeDefined();

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://example.com/webhook",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ hello: "world" }),
          signal: expect.any(AbortSignal),
        }),
      );
    });

    it("should return response headers", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse(200, "OK", {
          "x-request-id": "req-123",
          "x-ratelimit-remaining": "99",
        }),
      );

      const result = await deliverWebhook(
        "http://example.com/webhook",
        "POST",
        {},
        "{}",
        5000,
      );

      expect(result.headers["x-request-id"]).toBe("req-123");
      expect(result.headers["x-ratelimit-remaining"]).toBe("99");
    });

    it("should truncate response bodies exceeding maxBodyBytes", async () => {
      const largeBody = "x".repeat(200);
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(mockFetchResponse(200, largeBody));

      const result = await deliverWebhook(
        "http://example.com/webhook",
        "POST",
        {},
        "{}",
        5000,
        100, // maxBodyBytes = 100
      );

      expect(result.body!.length).toBeLessThan(largeBody.length);
      expect(result.body).toContain("[TRUNCATED]");
    });

    it("should handle non-2xx status codes without throwing", async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(mockFetchResponse(500, "Internal Server Error"));

      const result = await deliverWebhook(
        "http://example.com/webhook",
        "POST",
        {},
        "{}",
        5000,
      );

      expect(result.status).toBe(500);
      expect(result.body).toBe("Internal Server Error");
    });

    it("should throw on network failure with duration info", async () => {
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(new Error("ECONNREFUSED"));

      await expect(
        deliverWebhook(
          "http://example.com/webhook",
          "POST",
          {},
          "{}",
          5000,
        ),
      ).rejects.toThrow("Webhook delivery failed: ECONNREFUSED");
    });

    it("should throw timeout error when AbortError fires", async () => {
      const abortError = new Error("aborted");
      abortError.name = "AbortError";
      globalThis.fetch = vi.fn().mockRejectedValue(abortError);

      await expect(
        deliverWebhook(
          "http://example.com/webhook",
          "POST",
          {},
          "{}",
          100,
        ),
      ).rejects.toThrow("Webhook delivery timeout after 100ms");
    });

    it("should handle empty response body gracefully", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        headers: new Headers(),
        body: null, // No body on 204
        arrayBuffer: vi.fn(),
      });

      const result = await deliverWebhook(
        "http://example.com/webhook",
        "POST",
        {},
        "{}",
        5000,
      );

      expect(result.status).toBe(204);
      expect(result.body).toBeNull();
    });
  });

  // ── shouldRetryDelivery ───────────────────────────────────────────────────

  describe("shouldRetryDelivery", () => {
    it("should retry 5xx status codes by default", () => {
      expect(shouldRetryDelivery(500)).toBe(true);
      expect(shouldRetryDelivery(502)).toBe(true);
      expect(shouldRetryDelivery(503)).toBe(true);
      expect(shouldRetryDelivery(504)).toBe(true);
    });

    it("should retry 429 Too Many Requests by default", () => {
      expect(shouldRetryDelivery(429)).toBe(true);
    });

    it("should NOT retry typical 4xx by default", () => {
      expect(shouldRetryDelivery(400)).toBe(false);
      expect(shouldRetryDelivery(401)).toBe(false);
      expect(shouldRetryDelivery(403)).toBe(false);
      expect(shouldRetryDelivery(404)).toBe(false);
      expect(shouldRetryDelivery(422)).toBe(false);
    });

    it("should NOT retry 2xx or 3xx", () => {
      expect(shouldRetryDelivery(200)).toBe(false);
      expect(shouldRetryDelivery(201)).toBe(false);
      expect(shouldRetryDelivery(301)).toBe(false);
      expect(shouldRetryDelivery(302)).toBe(false);
    });

    it("should use custom retry status codes when provided", () => {
      expect(shouldRetryDelivery(400, [400, 408])).toBe(true);
      expect(shouldRetryDelivery(408, [400, 408])).toBe(true);
      expect(shouldRetryDelivery(500, [400, 408])).toBe(false);
    });

    it("should retry on Error instances (network errors)", () => {
      expect(shouldRetryDelivery(new Error("timeout"))).toBe(true);
      expect(shouldRetryDelivery(new Error("ECONNRESET"))).toBe(true);
    });

    it("should return false for undefined/no status", () => {
      expect(shouldRetryDelivery(undefined)).toBe(false);
    });
  });
});
