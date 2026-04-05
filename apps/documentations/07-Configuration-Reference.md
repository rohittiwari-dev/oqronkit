# Chapter 6: Configuration Reference

## `defineConfig()` — The Global Configuration

All core OqronKit infrastructure behavior is controlled through a single configuration object passed at startup. Note that individual Module configurations (like specific timeouts or retries) are configured locally on the module execution definitions themselves, or passed into the `.init()` lifecycle array.

```typescript
import { defineConfig } from "oqronkit";

export default defineConfig({
  project: "my-saas-app",
  environment: process.env.NODE_ENV ?? "development",
  
  // Storage architecture selection
  mode: "db", // "default" | "db" | "redis" | "hybrid-db"
  postgres: { connectionString: process.env.DATABASE_URL },

  // Module enablement explicitly required to boot
  modules: ["cron", "scheduler", "queue", "webhook"],
});
```

---

## Top-Level Architecture Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `project` | `string` | `"oqronkit"` | Service/project name — used in lock keys and namespacing |
| `environment` | `string` | `"development"` | Environment isolation key — nodes only process same-env jobs |
| `mode` | `string` | `"default"` | Defines which adapters to use: `"default"`, `"db"`, `"redis"`, `"hybrid-db"` |
| `modules` | `string[]` | `[]` | Which modules to activate: `"cron"`, `"scheduler"`, `"queue"`, `"webhook"` |
| `redis` | `string \| object` | — | Redis connection URL or ioredis instance |
| `postgres` | `object` | — | PostgreSQL connection config (see below) |
| `triggers` | `string \| false` | `auto` | Auto-discovery directory (e.g. `./src/jobs`), or `false` to disable. |
| `tags` | `string[]` | `[]` | Global tags applied to every job processed by this node |

---

## PostgreSQL Adapter (`config.postgres`)

Required if `mode` is `"db"` or `"hybrid-db"`.

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

---

## Observability (`config.observability`)

Controls the strict boundaries of telemetry limits retained internally within the database engines.

```typescript
observability: {
    maxJobLogs: 200,
    maxTimelineEntries: 20,
    trackMemory: true,
    logCollector: true,
    logCollectorMaxGlobal: 500,
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxJobLogs` | `number` | `200` | Max number of log entries per job log boundary. |
| `maxTimelineEntries` | `number` | `20` | Max number of timeline entries |
| `trackMemory` | `boolean` | `true` | Memory footprint metrics gathered post-execution |
| `logCollector` | `boolean` | `true` | Global buffering enabled |
| `logCollectorMaxGlobal` | `number` | `500` | Cap buffered lines globally for memory limits |

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
| `enabled` | `boolean` | `true` | Enable/disable console outputs from voltlog |
| `level` | `string` | `"info"` | Min log level: `"trace"` \| `"debug"` \| `"info"` \| `"warn"` \| `"error"` |
| `prettify` | `boolean` | `false` | Human readable output colors (ideal for Dev) |
| `showMetadata` | `boolean` | `true` | Include backend struct tags in outputs |
| `redact` | `string[]` | `[]` | Secure key masking strings |

---

## Shutdown & Lifecycle Hooks (`config.shutdown`)

Ensures nodes safely await running operations before disconnecting processes on `SIGINT`.

```typescript
shutdown: {
  enabled: true,
  timeout: 30000,
  signals: ["SIGINT", "SIGTERM"],
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Intercept process exit commands immediately |
| `timeout` | `number` | `30000` | Max milliseconds jobs can finish before hard SIGKILL |
| `signals` | `string[]` | `["SIGINT", "SIGTERM"]` | OS identifiers to intercept |
