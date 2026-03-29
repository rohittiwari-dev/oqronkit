# Chapter 8: Configuration Reference

## `defineConfig()` — The Global Configuration

All OqronKit behavior is controlled through a single configuration object passed at startup:

```typescript
import { defineConfig } from "oqronkit";

export default defineConfig({
  project: "my-saas-app",
  environment: process.env.NODE_ENV ?? "development",
  modules: ["cron", "scheduler", "taskQueue", "worker"],

  // Module-specific settings below...
});
```

---

## Top-Level Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `project` | `string` | `"oqronkit"` | Service/project name — used in lock keys and namespacing |
| `environment` | `string` | `"development"` | Environment isolation key — workers only process same-env jobs |
| `modules` | `string[]` | `[]` | Which modules to activate: `"cron"`, `"scheduler"`, `"taskQueue"`, `"queue"`, `"worker"` |
| `redis` | `string \| object` | — | Redis connection URL or ioredis instance |
| `postgres` | `object` | — | PostgreSQL connection config (see below) |
| `jobsDir` | `string` | `"./src/jobs"` | Directory for auto-discovery of job definition files |
| `tags` | `string[]` | `[]` | Global tags applied to every job processed by this node |

---

## Cron Module (`config.cron`)

```typescript
cron: {
  enable: true,
  timezone: "UTC",
  tickInterval: 1000,
  missedFirePolicy: "run-once",
  maxConcurrentJobs: 5,
  leaderElection: true,
  keepJobHistory: true,
  keepFailedJobHistory: true,
  shutdownTimeout: 25000,
  lagMonitor: { maxLagMs: 5000, sampleIntervalMs: 1000 },
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enable` | `boolean` | `true` | Enable/disable the cron module entirely |
| `timezone` | `string` | `"UTC"` | Global timezone fallback for cron expressions |
| `tickInterval` | `number` | `1000` | Polling loop interval in ms |
| `missedFirePolicy` | `string` | `"run-once"` | `"skip"` \| `"run-once"` \| `"run-all"` — behavior on missed executions |
| `maxConcurrentJobs` | `number` | `5` | Max concurrent cron handlers across the cluster |
| `leaderElection` | `boolean` | `true` | Enable leader election for cron tick ownership |
| `keepJobHistory` | `boolean \| number` | `true` | Retention for successful cron runs |
| `keepFailedJobHistory` | `boolean \| number` | `true` | Retention for failed cron runs |
| `shutdownTimeout` | `number` | `25000` | Max ms to wait for active crons to drain on shutdown |
| `lagMonitor.maxLagMs` | `number` | `5000` | Alert threshold for tick lag |
| `lagMonitor.sampleIntervalMs` | `number` | `1000` | Lag sampling frequency |

---

## Scheduler Module (`config.scheduler`)

```typescript
scheduler: {
  enable: true,
  tickInterval: 1000,
  timezone: "UTC",
  leaderElection: true,
  keepJobHistory: true,
  keepFailedJobHistory: true,
  shutdownTimeout: 25000,
  lagMonitor: { maxLagMs: 5000, sampleIntervalMs: 1000 },
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enable` | `boolean` | `true` | Enable/disable the scheduler module |
| `tickInterval` | `number` | `1000` | Polling loop interval in ms |
| `timezone` | `string` | `"UTC"` | Global timezone fallback for schedules |
| `leaderElection` | `boolean` | `true` | Enable leader election for schedule tick ownership |
| `keepJobHistory` | `boolean \| number` | `true` | Retention for successful schedule runs |
| `keepFailedJobHistory` | `boolean \| number` | `true` | Retention for failed schedule runs |
| `shutdownTimeout` | `number` | `25000` | Max ms to drain active schedules on shutdown |

---

## TaskQueue Module (`config.taskQueue`)

```typescript
taskQueue: {
  concurrency: 5,
  strategy: "fifo",
  heartbeatMs: 5000,
  lockTtlMs: 30000,
  retries: {
    max: 3,
    strategy: "exponential",
    baseDelay: 2000,
    maxDelay: 60000,
  },
  deadLetter: { enabled: true },
  removeOnComplete: false,
  removeOnFail: false,
  shutdownTimeout: 25000,
  maxStalledCount: 1,
  stalledInterval: 30000,
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `concurrency` | `number` | `5` | Default parallel execution limit |
| `strategy` | `"fifo" \| "lifo" \| "priority"` | `"fifo"` | Job ordering strategy |
| `heartbeatMs` | `number` | `5000` | Polling interval for job pickup |
| `lockTtlMs` | `number` | `30000` | Lock TTL for crash detection |
| `retries.max` | `number` | `3` | Default max retry attempts |
| `retries.strategy` | `string` | `"exponential"` | `"fixed"` \| `"exponential"` |
| `retries.baseDelay` | `number` | `2000` | Base delay in ms |
| `retries.maxDelay` | `number` | `60000` | Exponential cap in ms |
| `deadLetter.enabled` | `boolean` | `true` | Enable DLQ hooks |
| `removeOnComplete` | `RemoveOnConfig` | `false` | Default completed job pruning |
| `removeOnFail` | `RemoveOnConfig` | `false` | Default failed job pruning |
| `shutdownTimeout` | `number` | `25000` | Max ms to drain active jobs on shutdown |
| `maxStalledCount` | `number` | `1` | Max stall recoveries before marking as failed |
| `stalledInterval` | `number` | `30000` | Stall check frequency in ms |

---

## Worker Module (`config.worker`)

```typescript
worker: {
  concurrency: 5,
  heartbeatMs: 5000,
  lockTtlMs: 30000,
  retries: {
    max: 3,
    strategy: "exponential",
    baseDelay: 2000,
    maxDelay: 60000,
  },
  deadLetter: { enabled: true },
  removeOnComplete: false,
  removeOnFail: false,
  shutdownTimeout: 25000,
  maxStalledCount: 1,
  stalledInterval: 30000,
}
```

Same options as TaskQueue (plus `strategy`) — these serve as global defaults for all `Worker` instances. Per-worker options override these.

---

## PostgreSQL Adapter (`config.postgres`)

```typescript
postgres: {
  connectionString: "postgresql://user:pass@localhost:5432/oqronkit",
  tablePrefix: "oqron",
  poolSize: 10,
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `connectionString` | `string` | required | PostgreSQL connection URL |
| `tablePrefix` | `string` | `"oqron"` | Table name prefix for all OqronKit tables |
| `poolSize` | `number` | `10` | Connection pool size |

> **Adapter priority:** If `postgres` is set, PostgreSQL adapters are used. Otherwise if `redis` is set, Redis adapters are used. Otherwise, in-memory adapters are used (development).

---

## Queue Module (`config.queue`)

```typescript
queue: {
  defaultTtl: 86400000,   // 24 hours in ms
  ack: "leader",           // "leader" | "all" | "none"
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `defaultTtl` | `number` | `86400000` | Default message TTL in ms |
| `ack` | `string` | `"leader"` | Acknowledgement mode |

---

## Logger (`config.logger`)

```typescript
logger: {
  enabled: true,
  level: "info",
  prettify: false,
  showMetadata: true,
  redact: [],
}
// Or disable entirely:
logger: false
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable/disable logging |
| `level` | `string` | `"info"` | Min log level: `"trace"` \| `"debug"` \| `"info"` \| `"warn"` \| `"error"` |
| `prettify` | `boolean` | `false` | Pretty-print output (dev mode) |
| `showMetadata` | `boolean` | `true` | Include structured metadata in logs |
| `redact` | `string[]` | `[]` | Fields to redact from log output |

---

## Shutdown (`config.shutdown`)

```typescript
shutdown: {
  enabled: true,
  timeout: 30000,
  signals: ["SIGINT", "SIGTERM"],
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable graceful shutdown handling |
| `timeout` | `number` | `30000` | Max ms to wait before force-killing |
| `signals` | `string[]` | `["SIGINT", "SIGTERM"]` | OS signals to intercept |

---

## Telemetry (`config.telemetry`)

```typescript
telemetry: {
  prometheus: { enabled: false, path: "/metrics" },
  opentelemetry: { enabled: false },
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `prometheus.enabled` | `boolean` | `false` | Enable Prometheus metrics export |
| `prometheus.path` | `string` | `"/metrics"` | HTTP path for metrics endpoint |
| `opentelemetry.enabled` | `boolean` | `false` | Enable OpenTelemetry tracing |

---

## `RemoveOnConfig` Type Reference

Used by `removeOnComplete`, `removeOnFail`, and internally by `keepHistory`:

```typescript
type RemoveOnConfig =
  | boolean           // true = remove immediately, false = keep forever
  | number            // keep N most recent
  | {
      age?: number;   // max age in seconds
      count?: number; // max count
    };
```
