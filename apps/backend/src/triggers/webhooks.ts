import { webhook } from "oqronkit";

/**
 * Enterprise Webhook Dispatcher
 * Demonstrates Fan-out distribution, HMAC signatures, and Glob matching.
 */
export const platformWebhooks = webhook({
  name: "platform-events",
  concurrency: 10,

  // Custom retry behavior for this specific distribution
  retries: {
    max: 3,
    strategy: "exponential",
    baseDelay: 2000,
  },

  security() {
    return {
      signingSecret: "asdasdasd",
    };
  },

  async endpoints() {
    return [
      {
        name: "AcmeCorp Integration",
        url: "https://api.acme.com/v1/webhooks/receive",
        // Subscribes to all order events using glob matching
        events: ["order.**", "user.signup"],
        security: {
          signingAlgorithm: "sha256",
          signingSecret: process.env.ACME_WEBHOOK_SECRET || "fallback-secret",
          signingHeader: "x-acme-signature",
        },
      },
      {
        name: "Internal Analytics Stream",
        url: "https://data.internal.svc/ingest",
        // Matches a single segment wildcard
        events: ["user.*.activated", "system.health"],
        // endpoints can also omit security if they are purely internal
      },
    ];
  },
});

// Example Event Firings:
// These could be triggered anywhere inside your Express/Nest API codebase

// Matches both AcmeCorp (order.**) and is ignored by Internal Analytics
platformWebhooks.fire("order.payment.completed", {
  orderId: "ord_123xyz",
  amount: 450.0,
  currency: "USD",
});

// Matches AcmeCorp (user.signup)
platformWebhooks.fire("user.signup", {
  userId: "usr_abc890",
  email: "newuser@example.com",
});

// Matches Internal Analytics (user.*.activated)
platformWebhooks.fire("user.onboarding.activated", {
  userId: "usr_abc890",
  timestamp: Date.now(),
});
