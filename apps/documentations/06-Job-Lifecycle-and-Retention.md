# Chapter 7: Job Lifecycle & Retention

## Job States

Every background operation in OqronKit — whether cron, schedule, queue, or webhook — follows the same lifecycle state machine:

```
                    ┌──────────┐
                    │  waiting  │ ← Job created, ready for pickup
                    └─────┬────┘
                          │ Engine claims
                          ▼
                    ┌──────────┐
            ┌──────│  active   │──────┐
            │      └──────────┘      │
            │ success            fail│
            ▼                        ▼
      ┌───────────┐     ┌────────────────────┐
      │ completed │     │ retries remaining? │
      └───────────┘     └────────┬───────────┘
                                 │
                      ┌──────────┴──────────┐
                      │ yes                 │ no
                      ▼                     ▼
                ┌──────────┐          ┌──────────┐
                │ delayed  │          │  failed  │
                │ (backoff)│          │ (final)  │
                └─────┬────┘          └──────────┘
                      │ delay expires        │
                      └──→ active            │ DLQ hook fires
                                             ▼
```

### State Definitions

| State | Description |
|-------|-------------|
| `waiting` | Job is persisted and signaled to the broker, ready for the engine to claim |
| `active` | The engine has claimed the job and is currently executing the handler |
| `completed` | Handler returned successfully — `returnValue` is stored |
| `failed` | All retry attempts exhausted — `error` and `stacktrace` are stored |
| `delayed` | Waiting for a specific time: either initial delay or backoff between retries |
| `paused` | Manually stopped (future feature) |
| `stalled` | Engine lost heartbeat — the job will be reclaimed by the StallDetector |

---

## The Unified Job Record (`OqronJob`)

Every module writes the same record format to Storage, enabling a unified dashboard and API across all modules:

```typescript
interface OqronJob<T, R> {
  // ── Identity ────────────────────────────────
  id: string;              // UUID or custom jobId
  type: JobType;           // "task" | "cron" | "schedule" | ...
  queueName: string;       // Which queue/module namespace
  status: JobStatus;       // Current lifecycle state

  // ── Payloads ────────────────────────────────
  data: T;                 // Input payload
  opts: OqronJobOptions;   // Options used at creation
  returnValue?: R;         // Handler result (on success)
  error?: string;          // Error message (on failure)
  stacktrace?: string[];   // Error stacks (on failure)

  // ── Execution ───────────────────────────────
  attemptMade: number;     // Attempts completed (1-based)
  progressPercent: number; // 0-100 progress
  progressLabel?: string;  // Human-readable progress
  workerId?: string;       // Which node processed this
  stalledCount?: number;   // Times the job has stalled

  // ── Relationships ───────────────────────────
  parentId?: string;       // Parent job (for DAG/flow)
  scheduleId?: string;     // Linked cron/schedule name

  // ── Metadata ────────────────────────────────
  tags: string[];          // Categorization tags
  environment?: string;    // "development" | "production"
  project?: string;        // Project namespace

  // ── Timestamps ──────────────────────────────
  createdAt: Date;         // When created
  startedAt?: Date;        // When processing began
  finishedAt?: Date;       // When completed or failed
  runAt?: Date;            // Scheduled execution time
}
```

---

## Retry & Backoff

OqronKit provides two built-in backoff strategies for retry logic:

### Fixed Backoff
Waits the same amount of time between every retry.

```typescript
retries: { max: 3, strategy: "fixed", baseDelay: 5000 }
// Attempt 1: handler → fail → wait 5000ms
// Attempt 2: handler → fail → wait 5000ms
// Attempt 3: handler → fail → wait 5000ms
// Attempt 4: handler → fail → PERMANENTLY FAILED
```

### Exponential Backoff
Doubles the delay after each failure: `baseDelay × 2^(attempt - 1)`.

```typescript
retries: { max: 3, strategy: "exponential", baseDelay: 2000, maxDelay: 30000 }
// Attempt 1: handler → fail → wait 2000ms   (2000 × 2^0)
// Attempt 2: handler → fail → wait 4000ms   (2000 × 2^1)
// Attempt 3: handler → fail → wait 8000ms   (2000 × 2^2)
// Attempt 4: handler → fail → PERMANENTLY FAILED
```

The `maxDelay` option caps exponential growth to prevent unreasonably long wait times.

### Retry Config Cascade

Retry settings resolve from most-specific to least-specific:

1. **Per-job** (`opts.attempts` + `opts.backoff` on `.add()`) — highest priority
2. **Per-module** (`retries` on `queue()` or `webhook()` config)
3. **Engine defaults** (`max: 3, strategy: "exponential", baseDelay: 2000`)

---

## Job Retention & History Pruning

OqronKit uses **lazy pruning** — jobs are cleaned up when new completions/failures occur, not via background timers. This avoids unnecessary database polling and scales naturally with workload.

### Configuration Options

Retention is configured via `removeOnComplete` and `removeOnFail` (Queue/Webhook) or `keepHistory` and `keepFailedHistory` (Cron/Schedule):

| Value | Behavior |
|-------|----------|
| `false` (default) | Keep all jobs forever |
| `true` | Remove immediately upon completion/failure |
| `100` (number) | Keep the 100 most recent, prune older ones |
| `{ count: 100 }` | Same as above |
| `{ age: 3600 }` | Prune jobs older than 1 hour (in seconds) |
| `{ age: 86400, count: 1000 }` | Keep max 1000 AND no older than 24 hours |

### Where to Configure

Retention resolves from three levels (highest priority first):

```typescript
// 1. Per-job (on .add() call)
await queue.add("task", data, {
  removeOnComplete: { count: 50 },    // This job specifically
});

// 2. Per-queue/webhook (on definition)
const q = queue({
  name: "my-queue",
  removeOnComplete: { count: 500 },   // All jobs on this queue
  removeOnFail: { age: 86400 },
});

// 3. Global modules array (in defineConfig)
defineConfig({
  modules: [
    queueModule({ removeOnComplete: false, removeOnFail: { count: 1000 } })
  ],
});
```

### Cron & Schedule Naming

Crons and schedules use `keepHistory` / `keepFailedHistory` which map internally to the same pruning logic:

| `keepHistory` Value | Equivalent `removeOnComplete` |
|---------------------|-------------------------------|
| `true` (default) | `false` (keep all) |
| `false` | `true` (remove immediately) |
| `50` (number) | `{ count: 50 }` (keep 50 most recent) |

```typescript
cron({
  name: "daily-cleanup",
  keepHistory: 30,        // Keep last 30 successful runs
  keepFailedHistory: 100, // Keep last 100 failures for debugging
  handler: async (ctx) => { ... },
});
```

---

## Dead Letter Queue (DLQ)

When all retries are exhausted and a job permanently fails, OqronKit can invoke a Dead Letter Queue hook. This is your last line of defense for handling unrecoverable failures:

```typescript
queue({
  name: "payment-processing",
  retries: { max: 5, strategy: "exponential", baseDelay: 5000 },

  deadLetter: {
    enabled: true,
    onDead: async (job) => {
      // Alert your operations team
      await slack.send(`🚨 Payment ${job.data.paymentId} permanently failed`);

      // Log to external error tracking
      await sentry.captureMessage(`DLQ: ${job.error}`, {
        extra: { jobId: job.id, data: job.data, stacktrace: job.stacktrace },
      });

      // Optionally re-queue to a manual review system
      await manualReviewQueue.add({ originalJob: job });
    },
  },
});
```

DLQ is available on both `queue()` and `webhook()` configurations.
