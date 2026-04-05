# OqronKit

![License](https://img.shields.io/npm/l/oqronkit?style=flat-square)

**OqronKit** is a crash-safe, framework-agnostic background computation engine for Node.js. 

It cleanly replaces your cron scheduler, job queue, retry engine, webhook dispatcher, dead-letter queue, and distributed locking infrastructure. Deploy it as a single-server monolith for simple applications, and scale it seamlessly as a globally distributed microservice architecture when your traffic grows—without changing your code.

---

## 🌟 Features

- **4 Core Modules**: Queue, Webhooks, Cron, and Schedule.
- **Microservice Ready**: Pluggable storage architecture. Runs entirely in-memory for development, or use **PostgreSQL / Redis** for distributed, horizontally scaled production environments.
- **Crash-Safe**: Heartbeat locks, Stall Detection, and automatic job recovery if a process dies unexpectedly.
- **Enterprise Webhooks**: Secure outbound dispatching with deep-glob event matchers (`user.*.created`), SHA-256/512 HMAC signatures, and fan-out distribution.
- **Job Dependencies (DAG)**: Build complex node graphs (`dependsOn`). Control execution flow with `cascade-fail` or strict `block` failure policies.
- **Dynamic Pausing**: Use `disabledBehavior` to intelligently `"hold"`, `"skip"`, or `"reject"` job pipelines when modules are temporarily disabled.
- **Strict Environment Isolation**: Tag tasks with `project` and `environment` names to completely prevent catastrophic test-vs-production execution bleed.

---

## 📦 Installation

```bash
npm install oqronkit
```

*Optional Storage Adapters:*
```bash
npm install pg       # For PostgreSQL storage & locking
npm install ioredis  # For Redis storage & locking
```

---

## 🚀 Quick Start

### 1. Initialize the Engine

Configure and boot OqronKit when your application starts.

```typescript
import { defineConfig, OqronKit } from "oqronkit";

export default defineConfig({
  project: "my-saas-core",
  environment: process.env.NODE_ENV ?? "development",
  
  // Choose your storage backend ('default' = in-memory)
  mode: "default", 
  
  // Enable the specific modules you intend to use
  modules: ["cron", "scheduler", "queue", "webhook"],
  
  // Auto-discovers and registers jobs in this directory
  triggers: "./src/jobs", 
});

await OqronKit.init();
console.log("OqronKit is ready!");
```

---

### 2. Queue (Background Jobs)

A monolithic developer experience that automatically distributes workloads across cluster nodes. Job definitions and handlers live side-by-side.

```typescript
import { queue } from "oqronkit";

export const emailQueue = queue<{ to: string; template: string }>({
  name: "email-delivery",
  concurrency: 5,
  retries: { max: 3, strategy: "exponential", baseDelay: 2000 },
  
  handler: async (ctx) => {
    // Check for graceful shutdown signals natively
    if (ctx.signal.aborted) return;
    
    await mailer.send(ctx.data.to, ctx.data.template);
    return { delivered: true };
  },
});

// Enqueue jobs from your API routes:
await emailQueue.add({ to: "user@example.com", template: "welcome" });
```

---

### 3. Webhooks (Event Dispatching)

Securely dispatch outbound payloads to partners or internal 3rd party APIs with automatic retry policies.

```typescript
import { webhook } from "oqronkit";

export const billingWebhook = webhook({
  name: "billing-dispatch",
  concurrency: 10,
  endpoints: [
    {
      url: "https://api.partner.com/webhooks",
      events: ["user.billing.**"], // Matches billing.paid, billing.refunded.etc
      security: {
        signingSecret: process.env.WEBHOOK_SECRET,
        signingAlgorithm: "sha256",
        signingHeader: "x-partner-signature"
      }
    }
  ],
});

// Broadcast the event. OqronKit will match the pattern, sign the payload, 
// and reliably dispatch it over the network in the background.
await billingWebhook.fire("user.billing.payment_succeeded", {
  userId: "usr_123", amount: 50.00
});
```

---

### 4. Cron (Recurring Tasks)

Easily configure robust background sweeps that overlap gracefully.

```typescript
import { cron } from "oqronkit";

export const nightlySweep = cron({
  name: "db-cleanup",
  expression: "0 0 * * *", // Midnight UTC
  overlap: "skip",         // Prevents stampeding
  disabledBehavior: "skip",// Safely bypass if disabled via dashboard
  
  handler: async (ctx) => {
    const deleted = await db.cleanAbandonedCarts();
    return { deleted };
  },
});
```

---

### Job Dependencies (DAG)

Build complex execution pipelines where steps wait for their parents to complete.

```typescript
// Add the parent job
const extractJob = await extractQueue.add({ source: "aws-s3" });

// Add the child job, telling it to wait for the parent
const transformJob = await transformQueue.add(
  { target: "warehouse" },
  { 
      dependsOn: [extractJob.id],
      parentFailurePolicy: "cascade-fail" // Fail if extraction fails
  }
);
```

---

## 🤝 Contributing

1. Fork the project
2. Create your feature branch (`git checkout -b feat/my-feature`)
3. Write module tests inside `test/<module>/` to match new features.
4. Ensure `bunx vitest run` passes across all testing vectors natively.
5. Open a Pull Request

## 📜 License

[MIT](./LICENSE)
