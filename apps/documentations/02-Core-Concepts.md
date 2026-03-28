# Chapter 2: Core Concepts

## 1. Crons (`cron()`) vs Schedules (`schedule()`)
OqronKit strictly separates **Time-Driven** events from **Data-Driven** events to prevent memory bloat and API confusion.

### `cron()` (The Global Process)
A global background job. It runs on a fixed interval (`every: { hours: 1 }`) regardless of user activity. 
- It **never receives a `payload`**. 
- It is designed exclusively to clean databases, sync API metrics, generate nightly system reports, and purge cache directories.
- Automatically boots dynamically across your cluster without any manual execution triggers `await trigger()`.

### `schedule()` (The Parameterized Template)
A dynamic task tied directly to a specific action. You define an empty base template (e.g., `payment-retry`), and you dynamically spawn thousands of independent clones of it across your database natively (`runAfter: { days: 3 }`), passing totally unique contextual payloads (`{ invoiceId: 'IV998' }`).
- Highly structured database entities.
- Tracked history.
- Specifically launched by a `.schedule()` endpoint call.

---

## 2. Multi-Tenant Namespacing
You can run your `staging` servers, your `local developer` laptops, and your `production` cluster off the exact same massive physical SQLite/Redis instance **without them ever stealing each other's jobs.**

By natively defining your configuration context:
```typescript
import { defineConfig } from "oqronkit";

export default defineConfig({
  project: "my-saas",
  environment: process.env.NODE_ENV
});
```
OqronKit automatically prefixes every single database row, internal execution ID, and system lock boundary natively under the hood as:  
`${project}:${environment}:${job_name}`

So when a local developer clicks "Send Welcome Email", the local SQLite DB mounts `my-saas:development:welcome-email`. The production server physically cannot see or execute that record because its pushdown locks exactly onto `my-saas:production:xxxx`.

---

## 3. Leader Election
If you deploy 5 API containers onto AWS ECS, allowing all 5 nodes to aggressively poll the SQL Database for "Due Jobs" will rapidly exhaust database IOPS limits (Spike CPU usage).

Instead, OqronKit features an internal **Heartbeat Leader Election**. 
All nodes continuously ping for the right to hold the "`oqron:scheduler:leader`" key internally. The node that wins becomes the **Master Poller**. Only the Leader interrogates the DB for Due Tasks. Once Due, the array of executions is natively dispatched using atomic network locks. If the Leader node crashes silently, the key expires within 3,000 milliseconds natively, and a secondary replica instantly adopts the Master title.
