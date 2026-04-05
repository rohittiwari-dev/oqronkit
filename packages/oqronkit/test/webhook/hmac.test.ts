import { describe, expect, it } from "vitest";
import {
  signWebhookPayload,
  verifyWebhookSignature,
} from "../../src/webhook/hmac.js";

describe("Webhook HMAC Utilities", () => {
  const sampleBody = JSON.stringify({ event: "test.event", foo: "bar" });
  const secret = "test-secret-key-for-hmac";
  const timestamp = 1625097600000;

  // ── signWebhookPayload ───────────────────────────────────────────────────

  describe("signWebhookPayload", () => {
    it("should produce a t=...,v1=... formatted signature", async () => {
      const sig = await signWebhookPayload(sampleBody, secret, timestamp);
      expect(sig).toMatch(/^t=\d+,v1=[a-f0-9]+$/);
      expect(sig).toContain(`t=${timestamp}`);
    });

    it("should produce deterministic output for same inputs", async () => {
      const sig1 = await signWebhookPayload(sampleBody, secret, timestamp);
      const sig2 = await signWebhookPayload(sampleBody, secret, timestamp);
      expect(sig1).toBe(sig2);
    });

    it("should produce different signatures for different bodies", async () => {
      const sig1 = await signWebhookPayload("body-a", secret, timestamp);
      const sig2 = await signWebhookPayload("body-b", secret, timestamp);
      expect(sig1).not.toBe(sig2);
    });

    it("should produce different signatures for different secrets", async () => {
      const sig1 = await signWebhookPayload(sampleBody, "secret-1", timestamp);
      const sig2 = await signWebhookPayload(sampleBody, "secret-2", timestamp);
      expect(sig1).not.toBe(sig2);
    });

    it("should use sha512 when specified (128 hex chars)", async () => {
      const sha256Sig = await signWebhookPayload(
        sampleBody,
        secret,
        timestamp,
        "sha256",
      );
      const sha512Sig = await signWebhookPayload(
        sampleBody,
        secret,
        timestamp,
        "sha512",
      );
      const sha256Hash = sha256Sig.split("v1=")[1];
      const sha512Hash = sha512Sig.split("v1=")[1];
      expect(sha256Hash).toHaveLength(64); // sha256 = 32 bytes = 64 hex
      expect(sha512Hash).toHaveLength(128); // sha512 = 64 bytes = 128 hex
    });

    it("should use a custom sign function if provided", async () => {
      const customFn = async (
        body: string,
        _sec: string,
        ts: number,
      ): Promise<string> => `custom-${ts}-${body.length}`;

      const sig = await signWebhookPayload(
        sampleBody,
        secret,
        timestamp,
        "sha256",
        customFn,
      );
      expect(sig).toBe(`custom-${timestamp}-${sampleBody.length}`);
    });
  });

  // ── verifyWebhookSignature ──────────────────────────────────────────────

  describe("verifyWebhookSignature", () => {
    it("should verify a valid signature round-trip", async () => {
      const now = Date.now();
      const sig = await signWebhookPayload(sampleBody, secret, now);
      const valid = verifyWebhookSignature(
        sig,
        sampleBody,
        secret,
        "sha256",
        60000,
      );
      expect(valid).toBe(true);
    });

    it("should verify sha512 signatures", async () => {
      const now = Date.now();
      const sig = await signWebhookPayload(
        sampleBody,
        secret,
        now,
        "sha512",
      );
      const valid = verifyWebhookSignature(
        sig,
        sampleBody,
        secret,
        "sha512",
        60000,
      );
      expect(valid).toBe(true);
    });

    it("should reject an expired signature", async () => {
      const oldTimestamp = Date.now() - 600000; // 10 min ago
      const sig = await signWebhookPayload(sampleBody, secret, oldTimestamp);
      // 5 min tolerance — signature is 10 mins old
      const valid = verifyWebhookSignature(
        sig,
        sampleBody,
        secret,
        "sha256",
        300000,
      );
      expect(valid).toBe(false);
    });

    it("should reject a tampered body", async () => {
      const now = Date.now();
      const sig = await signWebhookPayload(sampleBody, secret, now);
      const valid = verifyWebhookSignature(
        sig,
        "tampered-body",
        secret,
        "sha256",
        60000,
      );
      expect(valid).toBe(false);
    });

    it("should reject a wrong secret", async () => {
      const now = Date.now();
      const sig = await signWebhookPayload(sampleBody, secret, now);
      const valid = verifyWebhookSignature(
        sig,
        sampleBody,
        "wrong-secret",
        "sha256",
        60000,
      );
      expect(valid).toBe(false);
    });

    it("should reject malformed signature strings", () => {
      expect(
        verifyWebhookSignature("garbage", sampleBody, secret),
      ).toBe(false);
      expect(
        verifyWebhookSignature("t=123", sampleBody, secret),
      ).toBe(false);
      expect(
        verifyWebhookSignature("v1=abc", sampleBody, secret),
      ).toBe(false);
      expect(
        verifyWebhookSignature("", sampleBody, secret),
      ).toBe(false);
    });

    it("should reject non-numeric timestamp", () => {
      expect(
        verifyWebhookSignature("t=abc,v1=def", sampleBody, secret),
      ).toBe(false);
    });
  });
});
