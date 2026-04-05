# Chapter 5: Webhooks Module

## Overview

The `webhook()` module acts as a highly resilient outbound event distribution engine. It was built specifically to dispatch payloads safely to external B2B partners, 3rd party APIs, or micro-service hooks with rigorous retry capabilities.

Unlike `queue()` where you provide a local `handler` to execute JS logic, the Webhook module strictly executes network requests over `fetch` under the hood. It supports deep glob-based event matching (`*`, `**`), native payload signing (HMAC SHA256/512), and fan-out endpoints.

---

## When to Use `webhook()`

- **3rd-Party Integrations:** Pushing activity streams, alerts, or data syncs to a 3rd party endpoint.
- **Fan-Out Architectures:** Dispatching a single `user.signup` internal event that instantly fans out to 5 different partner APIs without blocking your main API thread.
- **Security & Authorization:** Creating securely signed payloads (`x-signature` headers) preventing tampering downstream.

---

## API Reference

### `webhook(config)` → `IWebhookDispatcher`

Creates a webhook dispatcher mapped to a designated set of routing endpoints and security protocols.

```typescript
import { webhook } from "oqronkit";

export const billingWebhooks = webhook({
  name: "billing-events",
  endpoints: [
    {
      url: "https://api.partner.com/events/billing",
      events: ["payment.success", "payment.failed"],
    }
  ],
});
```

### Config Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | required | Unique webhook module name identifier |
| `endpoints` | `WebhookEndpoint[]` | required | Array of destination URLs and matching conditions |
| `concurrency` | `number` | `5` | How many webhook payloads to dispatch parallel per node |
| `disabledBehavior` | `"hold" \| "skip" \| "reject"` | `"hold"` | Action taken if module is globally disabled |
| `retries.max` | `number` | `0` | Maximum network retry attempts on 5XX or Network/Timeout errors |
| `retries.strategy` | `"fixed" \| "exponential"` | `"exponential"` | Backoff algorithm bridging retries |
| `retries.baseDelay` | `number` | `2000` | Base delay between retries in ms |
| `removeOnComplete` | `boolean \| number \| KeepJobs` | `false` | Auto-prune successful dispatches |
| `removeOnFail` | `boolean \| number \| KeepJobs` | `false` | Auto-prune definitively failed external hooks |

### Endpoint Configuration

The true power of the Webhook module is derived from the `WebhookEndpoint` array. Each endpoint dictates exactly what event schemas it subscribes to, and how it is secured.

```typescript
type WebhookEndpoint = {
  url: string;
  // Deep glob supported schemas
  events: string[]; 
  // Custom headers appended to every request matching this endpoint
  headers?: Record<string, string>; 
  
  security?: {
      // Auto-hashes payload into request header 
      signingSecret: string;
      signingAlgorithm: "sha256" | "sha512";  // e.g., 'sha256'
      signingHeader: string;                  // e.g., 'X-Webhook-Signature'
  } | {
      // OR define a fully custom asynchronous bypass signature pipeline:
      customSigner: (payload: any) => Promise<Record<string, string>>;
  };
}
```

### Deep-Glob Event Matching

OqronKit supports segment-aware event matching routing payload deliveries automatically.
- `*` replaces exactly **one event segment**.
- `**` replaces **one or many segments**, allowing deep recursive matches.

```typescript
webhook({
  name: "global",
  endpoints: [
    {
       url: "https://api.example.com/all-billing",
       events: ["billing.**"]  // Matches billing.invoice.paid, billing.refunded, etc.
    },
    {
       url: "https://api.example.com/user-events",
       events: ["user.*.updated"] // Matches user.profile.updated strictly.
    }
  ]
})
```

### `.fire(event, payload, opts?)` — Dispatches Event

The `.fire` method handles fan-out seamlessly. If the event `"user.created"` matches **three** registered secure endpoints locally in the configuration, OqronKit spawns **three individual deterministic jobs** automatically in the background, uniquely guaranteeing individual retry matrices.

```typescript
await billingWebhooks.fire(
  "billing.invoice.paid", 
  { invoiceId: "inv_123", amount: 4900 },
  {
    // Native dispatcher options
    jobId: "unique-webhook-request-123", // Native idempotent protections
    delay: 5000 
  }
);
```

---

## Full Example: Partner Sync Webhook

```typescript
import { webhook } from "oqronkit";

export const eventDispatcher = webhook({
  name: "partner-data-sync",
  concurrency: 10,
  
  // Safe unmounting: Holds dispatches inside the broker if disabled globally via UI
  disabledBehavior: "hold", 
  
  retries: {
    max: 10, // Generous external retry
    strategy: "exponential",
    baseDelay: 2000, // 2s -> 4s -> 8s -> 16s...
  },
  
  endpoints: [
    {
      url: "https://integration.crm.com/v1/event-receiver",
      events: ["crm.user.**", "crm.account.deleted"],
      headers: {
        "x-api-key": process.env.CRM_API_KEY
      },
      security: {
        signingSecret: process.env.WEBHOOK_SECRET,
        signingAlgorithm: "sha256",
        signingHeader: "x-oqron-signature"
      }
    },
    {
       url: "https://custom-analytics.metrics.net/ingest",
       events: ["**"], // Catches ALL system payloads natively
       security: {
           customSigner: async (payload) => {
               // Produce a heavy encrypted token based off payloads
               const token = await generateJWTPayloadToken(payload);
               return { "authorization": `Bearer ${token}` }
           }
       }
    }
  ]
});

// Implementation:
export async function deleteUser(id: string) {
    await db.user.delete(id);
    
    // Automatically routes payload + strict security guarantees down to matching endpoints
    await eventDispatcher.fire("crm.user.deleted", { id, timestamp: Date.now() });
}
```

## Security Handshake Validation

When dealing with `signingSecret`, OqronKit utilizes the native Node `crypto` layer to rapidly encode the raw JSON stringified payload.

Receiver Example (`Express.js`):

```typescript
app.post("/v1/event-receiver", express.json(), (req, res) => {
    const signature = req.headers["x-oqron-signature"];
    
    // Validate matching
    const expected = crypto
      .createHmac("sha256", process.env.WEBHOOK_SECRET)
      .update(JSON.stringify(req.body))
      .digest("hex");
      
    if (signature !== expected) return res.status(401).send("Invalid Webhook");
    
    // Valid! Proceed!
});
```
