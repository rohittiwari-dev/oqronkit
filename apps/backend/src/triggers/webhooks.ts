/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  OqronKit — Webhook Module
 *  Fan-out event distribution with HMAC signing, glob matching, circuit breakers.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *  Features demonstrated:
 *  ✓ Glob-based endpoint matching ("order.**", "user.*.activated")
 *  ✓ Per-endpoint HMAC-SHA256 signatures
 *  ✓ Circuit breaker protection
 *  ✓ Exponential retry with DLQ
 *  ✓ Multiple endpoints receiving the same event
 *  ✓ Static and dynamic endpoint resolution
 */

import { webhook } from "oqronkit";

// ─────────────────────────────────────────────────────────────────────────────
// PLATFORM WEBHOOK DISPATCHER
// Fan-out events to external consumers with HMAC signing and circuit breakers.
// ─────────────────────────────────────────────────────────────────────────────
export const platformWebhooks = webhook({
  name: "platform-events",
  concurrency: 10,

  retries: {
    max: 3,
    strategy: "exponential",
    baseDelay: 2000,
  },

  security() {
    return {
      signingSecret: process.env.WEBHOOK_SIGNING_SECRET || "whsec_dev_secret",
    };
  },

  async endpoints() {
    return [
      {
        name: "AcmeCorp Integration",
        url: "https://api.acme.com/v1/webhooks/receive",
        events: ["order.**", "user.signup"],
        security: {
          signingAlgorithm: "sha256",
          signingSecret:
            process.env.ACME_WEBHOOK_SECRET || "acme-fallback-secret",
          signingHeader: "x-acme-signature",
        },
      },
      {
        name: "Internal Analytics Stream",
        url: "https://data.internal.svc/ingest",
        events: ["user.*.activated", "system.health"],
      },
      {
        name: "Partner Notification Service",
        url: "https://partner.example.com/hooks",
        events: ["order.payment.*", "subscription.*"],
        security: {
          signingAlgorithm: "sha256",
          signingSecret:
            process.env.PARTNER_WEBHOOK_SECRET || "partner-fallback-secret",
          signingHeader: "x-partner-signature",
        },
      },
    ];
  },
});
