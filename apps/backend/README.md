# OqronKit Backend Express Demo (v1.0)

This is an end-to-end sandbox application executing the full OqronKit v1 engine over an HTTP-driven Express.js environment.

## ✨ Features Showcased

| Module | Example File | Highlights |
|--------|-------------|------------|
| **Cron** | `src/jobs/crons.ts` | Time-based global sweeps, leader election |
| **Schedule** | `src/jobs/scheduler.ts` | Dynamic drip campaigns, trial expiration, RRULE |
| **TaskQueue** | `src/jobs/task-queues.ts` | Image processing, email sending, PDF generation |
| **Queue + Worker** | `src/jobs/distributed-workers.ts` | Order processing, bulk notifications, data exports |

### v1 Infrastructure Features
- **DI Container** (`OqronContainer`) — automatic adapter selection (Memory → Redis → PostgreSQL)
- **AbortController** — `ctx.signal` for mid-execution job cancellation
- **Job Ordering** — FIFO, LIFO, and Priority strategies
- **Crash Safety** — Heartbeat workers + stall detection + lock TTL
- **Retry/Backoff** — Fixed + exponential with configurable caps
- **Dead Letter Queue** — Hooks for permanently failed jobs
- **Admin API** — Health, events, trigger, queue management, job CRUD

## 🚀 Running The Application

Ensure your dependencies are installed via the monorepo:

```bash
bun install
```

Start the development server:

```bash
bun run dev
```

## 🔭 Live API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Application info and available endpoints |
| GET | `/api/oqron/health` | System status (modules, uptime, job counts) |
| GET | `/api/oqron/events?limit=25` | Recent event bus emissions |
| POST | `/api/oqron/jobs/:name/trigger` | Manually trigger a job/schedule |
| GET | `/api/oqron/metrics` | Prometheus-compatible metrics |
| POST | `/api/orders` | Publish an order to the distributed queue |
| POST | `/api/images/process` | Trigger image processing |
| DELETE | `/api/jobs/:jobId` | Cancel a running job (AbortController) |

## 📁 Source Architecture

```
src/
  ├── index.ts                      # Express server + OqronKit.init()
  └── jobs/
      ├── crons.ts                  # Time-driven recurring jobs
      ├── scheduler.ts              # Data-driven scheduled tasks
      ├── task-queues.ts            # Monolithic background tasks
      └── distributed-workers.ts    # Distributed Queue + Worker
```

*Powered by OqronKit v1.0 Enterprise.*
