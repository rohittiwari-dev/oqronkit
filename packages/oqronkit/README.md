# OqronKit

![Version](https://img.shields.io/npm/v/oqronkit?style=flat-square)
![License](https://img.shields.io/npm/l/oqronkit?style=flat-square)

OqronKit is a high-performance, enterprise-ready cron and job scheduling framework for Node.js. Designed for extreme scaling, multi-tenancy, and distributed microservices architectures, it features seamless Global Locking, automated Leader Election, missed-fire recovery, and zero-configuration database persistence.

Stop struggling with broken internal intervals. Scale confidently across a single monolith or a distributed 50-node cluster using SQLite, Redis, or Memory natively.

## 🌟 Key Features

- **Multi-Tenant Isolation**: Safely run `staging` and `production` environments off the exact same database without collision.
- **Global Distributed Locks**: Automatically prevents duplicate processing across clusters natively—you will never accidentally bill a user twice!
- **Leader Election**: Dynamically promotes a master node to handle system polling intervals natively.
- **Missed-Fire Recovery**: Automatic detection and recovery strategies (`run_now`, `skip`, or `discard`) when the server goes offline during a schedule.
- **Fully Declarative (`oqron.config.ts`)**: Define a single TS configuration file natively without writing massive infrastructure boots.
- **Stall Detection**: Natively monitors and revokes jobs if an executing worker crashes silently or hangs indefinitely.
- **File-based Auto-Routing**: Magically discovers and registers jobs simply by dropping `.ts` files into your `./jobs` directory!

## 📦 Installation

```bash
npm install oqronkit
# or
yarn add oqronkit
# or
bun add oqronkit
```

*Note: OqronKit bundles standard SQLite and Memory adapters internally. No additional database ORMs are required.*

## 🚀 Quick Start

### 1. Configuration (`oqron.config.ts`)
Create a single definition file at the root of your application to magically boot the entire underlying layer:

```typescript
import { defineConfig } from "oqronkit";

export default defineConfig({
  project: "my-saas-platform",
  environment: process.env.NODE_ENV || "development",
  modules: ["cron", "scheduler"], // Enable standard Crons & dynamic Timed Schedules
  jobsDir: "./src/jobs",          // OqronKit automatically finds jobs here
});
```

### 2. Define a Job (`src/jobs/emails.ts`)
Declare a job logic structure. OqronKit strongly enforces execution wrappers to track success, failure, and execution limits!

```typescript
import { cron } from "oqronkit";

export const dailyDigest = cron({
  name: "daily-digest",
  expression: "0 8 * * *", // Runs every day at 08:00 AM
  timezone: "UTC",
  overlap: "skip",         // If it's still sending yesterday's batch, skip today's run
  handler: async (ctx) => {
    ctx.logger.info("Gathering active users...", { 
      env: ctx.environment 
    });
    
    // Simulate complex DB queries natively
    await new Promise((r) => setTimeout(r, 1000));
    
    return { users_processed: 50 };
  }
});
```

### 3. Initialize Server
Simply inject `OqronKit.init()` natively into your backend bootstrapping logic!

```typescript
import { OqronKit } from "oqronkit";

async function boot() {
  await OqronKit.init(); 
  console.log("Enterprise Task Scheduling armed.");
}
boot();
```

---

## 🎛 Advanced Usage

### Dynamic Specific-Time Scheduling
Unlike generic Crons, `scheduler` natively handles firing dynamic "one-off" events inside user logic boundaries, explicitly persisting to the DB out of the box!

```typescript
import { schedule } from "oqronkit";

// 1. Define the handler type structure
export const subscriptionHandler = schedule<{ userId: string }>({
  name: "cancel-subscription-job",
  keepHistory: true, // Keep an internal audit trail within the DB
  handler: async (ctx) => {
    const { userId } = ctx.payload;
    console.log(`Cancelled user ${userId} natively!`);
  }
});

// 2. Trigger the job dynamically in your Express routes natively
await subscriptionHandler({ userId: "u_abc123" }, { 
  runAfter: { days: 3 } 
});
```

---

## 🏗 Architecture & Internal Isolation

By default, the `OqronAdapter` prefixes all Database identities mapping directly based on the config file context:
`${project}:${environment}:${job_name}`

This guarantees you can utilize the exact same Redis clusters, the same SQLite tables (`oqron_schedules`), and the identical physical database server for both your staging development servers and production monoliths flawlessly! The leader elections are mathematically isolated using the same prefix architecture natively.

## 🤝 Contributing
Issues and Pull Requests are welcome to natively expand support for PostgreSQL via `SKIP LOCKED` extensions and deeper Redis locks.

1. Fork the Project
2. Create your Feature Branch
3. Commit your Changes natively.
4. Push to the Branch natively.
5. Open a Pull Request!
