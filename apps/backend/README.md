# OqronKit Backend Express Demo

This is an end-to-end sandbox application executing the native functionality of the `oqronkit` scheduler engine over an HTTP-driven environment.

This example showcases:
1. Standard Time-based cron jobs.
2. Dynamically enqueued event delays (`ScheduleEngine`) natively persisting to SQLite.
3. Live status and monitoring API integration.

## 🚀 Running The Application

Ensure that your dependencies are freshly installed centrally via the Monorepo:

```bash
bun install
```

Start the application inside the Development isolated mode natively:

```bash
bun run dev

# Alternatively:
# npm run dev
# yarn dev
```

The Node.js `ts-node` engine will mount dynamic crons into database identity `backend-demo:development:xyz` dynamically!

## 🔭 Live API Endpoints

Once running, OqronKit auto-exposes a natively wrapped health-monitoring router!

- **GET http://localhost:3000/** : The primary overview instructions.
- **GET http://localhost:3000/api/oqron/health** : System status (Worker, Leader, Memory constraints).
- **GET http://localhost:3000/api/oqron/events?limit=25** : Taps directly into the `OqronEventBus` to stream past execution failures and successes instantly.
- **POST http://localhost:3000/api/oqron/jobs/:name/trigger** : Dynamically bypass the scheduling timeline and manually trigger a specific handler!

## 📁 Source Architecture

1. `cnforge.config.ts` handles the native configuration mappings and isolation boundaries mathematically defined for the `oqronkit` core. *(Depending on the migration step, you may see this file renamed to `oqron.config.ts`)*.
2. `src/jobs/` natively discovers `.ts` exported files holding `cron()` and `schedule()` objects logically grouping handlers!
   - `crons.ts` — Examples of recurring daily digest executions.
   - `scheduler.ts` — Example of a dynamic email drip campaign triggered explicitly.

*Powered by OqronKit Enterprise.*
