<p align="center">
  <img src="https://raw.githubusercontent.com/rohittiwari-dev/oqronkit/main/assets/icon.png" alt="OqronKit" width="80" />
</p>
<h3 align="center">OqronKit</h3>
<p align="center"><em>Crash-Safe Background Computation Engine for Node.js</em></p>

# ⚡ OqronKit — Background Job Engine for Node.js

A **crash-safe background job engine** for Node.js. Framework-agnostic, adapter-driven, and designed for horizontal scaling from day one. Replace your cron scheduler, job queue, retry engine, webhook dispatcher, dead-letter queue, and distributed locking infrastructure — with a single library.

> **Built with TypeScript**. Zero-framework-lock, pluggable storage (In-Memory → PostgreSQL → Redis), heartbeat-driven crash recovery, DAG job dependencies, and environment-isolated execution.

[![npm version](https://img.shields.io/npm/v/oqronkit.svg)](https://www.npmjs.com/package/oqronkit)
[![License](https://img.shields.io/npm/l/oqronkit.svg)](https://github.com/rohittiwari-dev/oqronkit/blob/main/LICENSE)
[![Tests](https://img.shields.io/badge/tests-741%20passing-brightgreen)](https://github.com/rohittiwari-dev/oqronkit)

## 📚 Full Documentation & API Reference

For full API reference, module deep-dives, architecture guides, and advanced usage, visit the **[Official Documentation](https://oqronkit.rohittiwari.me)**.

## ✨ Key Features

OqronKit provides the following core capabilities:

- ⚡ **4 Core Modules** — Task Queue, Webhooks, Cron Scheduler, and Interval Schedule engine
- 🔒 **Crash-Safe Execution** — Heartbeat locks, stall detection, and automatic job recovery on process death (`SIGKILL`/OOM)
- 🎯 **Strict TypeScript** — Fully typed APIs with Zod-validated configuration schemas
- 🏗️ **Adapter-Driven Architecture** — In-Memory for dev, PostgreSQL or Redis for distributed production — zero code changes
- 📡 **Robust Webhooks** — SHA-256/512 HMAC signing, deep-glob event matchers (`user.*.created`), fan-out distribution, and DLQ
- 🔄 **Job Dependencies (DAG)** — Build execution pipelines with `dependsOn`, `cascade-fail`, and `block` failure policies
- 🌐 **Horizontal Scaling** — Natively designed for multi-node worker pools with leader election and environment isolation
- 🛡️ **Dynamic Pausing** — Intelligently `"hold"`, `"skip"`, or `"reject"` jobs when modules are temporarily disabled
- 📊 **Abort Signal Propagation** — Native `AbortSignal` support in every handler context for graceful shutdown

## 🏛️ Adapter Architecture

OqronKit's pluggable storage layer transforms your deployment topology without touching business logic:

```
┌─────────────────────────────────────────────────────────┐
│                    Your Application                     │
├─────────────────────────────────────────────────────────┤
│                   OqronKit Engine                       │
│   ┌──────────┐  ┌──────────┐  ┌──────────────────┐     │
│   │  Queue   │  │   Cron   │  │     Webhook      │     │
│   │  Engine  │  │  Engine  │  │     Engine       │     │
│   └────┬─────┘  └────┬─────┘  └───────┬──────────┘     │
│        │              │               │                 │
│   ┌────▼──────────────▼───────────────▼──────────┐      │
│   │          Adapter Interface Layer             │      │
│   │   IOqronAdapter · ILockAdapter · IQueueAdapter│     │
│   └────┬──────────────┬───────────────┬──────────┘      │
│        │              │               │                 │
├────────▼──────────────▼───────────────▼─────────────────┤
│  ┌──────────┐   ┌──────────┐   ┌──────────┐            │
│  │ In-Memory│   │PostgreSQL│   │  Redis   │            │
│  │ (default)│   │ Adapter  │   │ Adapter  │            │
│  └──────────┘   └──────────┘   └──────────┘            │
└─────────────────────────────────────────────────────────┘
```

## 📦 Installation

```bash
npm install oqronkit
```

**Optional Storage Adapters:**

```bash
npm install pg       # PostgreSQL storage & distributed locking
npm install ioredis  # Redis storage & distributed locking
```

## 🚀 Quick Start

Get up and running with crash-safe background jobs in minutes.

### 1. Initialize the Engine

Configure and boot OqronKit when your application starts.

```typescript
import { defineConfig, OqronKit } from "oqronkit";

export default defineConfig({
  project: "my-saas-core",
  environment: process.env.NODE_ENV ?? "development",

  // Choose your storage backend ('default' = in-memory)
  mode: "default",

  // Enable the specific modules you need
  modules: ["cron", "scheduler", "queue", "webhook"],

  // Auto-discovers and registers jobs in this directory
  triggers: "./src/jobs",
});

await OqronKit.init();
console.log("OqronKit is ready!");
```

### 2. Task Queue — Background Jobs

A monolithic developer experience that automatically distributes workloads across cluster nodes.

```typescript
import { queue } from "oqronkit";

export const emailQueue = queue<{ to: string; template: string }>({
  name: "email-delivery",
  concurrency: 5,
  retries: { max: 3, strategy: "exponential", baseDelay: 2000 },

  handler: async (ctx) => {
    // Native abort signal for graceful shutdown
    if (ctx.signal.aborted) return;

    await mailer.send(ctx.data.to, ctx.data.template);
    return { delivered: true };
  },
});

// Enqueue jobs from your API routes:
await emailQueue.add({ to: "user@example.com", template: "welcome" });
```

### 3. Webhooks — Event Dispatching

Securely dispatch outbound payloads to partners or internal APIs with automatic retries and DLQ.

```typescript
import { webhook } from "oqronkit";

export const billingWebhook = webhook({
  name: "billing-dispatch",
  concurrency: 10,
  endpoints: [
    {
      url: "https://api.partner.com/webhooks",
      events: ["user.billing.**"], // Deep-glob pattern matching
      security: {
        signingSecret: process.env.WEBHOOK_SECRET,
        signingAlgorithm: "sha256",
        signingHeader: "x-partner-signature",
      },
    },
  ],
});

// OqronKit matches the pattern, signs the payload with HMAC,
// and reliably dispatches in the background with retries.
await billingWebhook.fire("user.billing.payment_succeeded", {
  userId: "usr_123",
  amount: 50.0,
});
```

### 4. Cron — Recurring Tasks

Configure robust recurring background sweeps with overlap protection and crash safety.

```typescript
import { cron } from "oqronkit";

export const nightlySweep = cron({
  name: "db-cleanup",
  expression: "0 0 * * *", // Midnight UTC
  overlap: "skip",          // Prevents stampeding
  disabledBehavior: "skip", // Safely bypass if disabled via dashboard

  handler: async (ctx) => {
    const deleted = await db.cleanAbandonedCarts();
    return { deleted };
  },
});
```

### 5. Schedule — Interval Engine

Fixed-interval execution with millisecond precision and concurrent execution limits.

```typescript
import { schedule } from "oqronkit";

export const healthCheck = schedule({
  name: "health-ping",
  interval: 30_000, // Every 30 seconds
  maxConcurrent: 1,

  handler: async (ctx) => {
    const status = await checkUpstream();
    return { healthy: status.ok };
  },
});
```

## ⚙️ Configuration Reference

### Engine Configuration (`defineConfig`)

| Option          | Type               | Default         | Description                                          |
| --------------- | ------------------ | --------------- | ---------------------------------------------------- |
| `project`       | `string`           | _required_      | Project namespace for environment isolation           |
| `environment`   | `string`           | `"development"` | Environment tag (`development`, `staging`, `production`) |
| `mode`          | `string`           | `"default"`     | Storage backend (`"default"` / `"postgres"` / `"redis"`) |
| `modules`       | `string[]`         | `[]`            | Modules to enable: `cron`, `scheduler`, `queue`, `webhook` |
| `triggers`      | `string`           | —               | Directory path for auto-discovered job definitions    |
| `concurrency`   | `number`           | `5`             | Global default worker concurrency                     |

### Queue Options

| Option        | Type                  | Default    | Description                                      |
| ------------- | --------------------- | ---------- | ------------------------------------------------ |
| `name`        | `string`              | _required_ | Unique queue identifier                           |
| `concurrency` | `number`              | `5`        | Max parallel handlers                             |
| `retries`     | `RetryConfig`         | —          | `{ max, strategy, baseDelay }` retry policy       |
| `timeout`     | `number`              | `30000`    | Job execution timeout (ms)                        |
| `dependsOn`   | `string[]`            | —          | Parent job IDs for DAG execution                  |
| `parentFailurePolicy` | `string`       | `"block"`  | `"cascade-fail"` or `"block"` on parent failure   |

### Webhook Endpoint Security

| Option             | Type     | Default    | Description                              |
| ------------------ | -------- | ---------- | ---------------------------------------- |
| `signingSecret`    | `string` | _required_ | HMAC secret for payload signing           |
| `signingAlgorithm` | `string` | `"sha256"` | `"sha256"` or `"sha512"`                 |
| `signingHeader`    | `string` | `"x-signature"` | HTTP header for the HMAC signature   |

## 🔗 Job Dependencies (DAG Pipelines)

Build complex execution pipelines where child jobs wait for their parents to complete.

```typescript
// Step 1: Add the parent job
const extractJob = await extractQueue.add({ source: "aws-s3" });

// Step 2: Add the child job with dependency
const transformJob = await transformQueue.add(
  { target: "warehouse" },
  {
    dependsOn: [extractJob.id],
    parentFailurePolicy: "cascade-fail", // Fail if extraction fails
  },
);
```

**DAG Failure Policies:**

| Policy          | Behavior                                             |
| --------------- | ---------------------------------------------------- |
| `cascade-fail`  | Child immediately fails when any parent fails         |
| `block`         | Child stays in `waiting` state until parent succeeds  |

## 🛡️ Crash Safety & Reliability

OqronKit's crash-safety model is built on three pillars:

1. **Heartbeat Locks** — Workers atomically claim jobs with a TTL-based lock and renew it periodically while executing.
2. **Stall Detection** — If a worker crashes (`SIGKILL`/OOM), the lock expires and the built-in `StallDetector` reclaims the job within ~15 seconds.
3. **Idempotent Handlers** — State is persisted before and after each step. Handlers are designed to safely re-execute during crash recovery.

```
Worker A claims job ──► Heartbeat renews lock every 5s
         │
    Process crashes (SIGKILL)
         │
    Lock TTL expires (~15s)
         │
StallDetector reclaims ──► Worker B picks up job
```

## 🤝 Contributing

1. Fork the project
2. Create your feature branch (`git checkout -b feat/my-feature`)
3. Write module tests inside `test/<module>/` to match new features
4. Ensure `bunx vitest run` passes across all testing vectors
5. Add a changeset with `bun run changeset` for publishable changes
6. Open a Pull Request

## 📜 License

[MIT](./LICENSE) — Built by [Rohit Tiwari](https://rohittiwari.me)
