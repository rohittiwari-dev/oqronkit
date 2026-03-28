import { DbLockAdapter, defineConfig, SqliteAdapter } from "chronoforge";

export default defineConfig({
  // 1. Identification
  project: "backend-api-demo",

  // 2. Environment Isolation
  environment: process.env.CHRONO_ENV ?? "development",

  // 3. Infrastructure setup — true explicit dependency injection
  db: new SqliteAdapter("data/chrono.sqlite"),
  lock: new DbLockAdapter("data/chrono.sqlite"),

  // 4. Enabled Modules
  modules: ["cron"], // The orchestrator will only start SchedulerModule when "cron" is specified

  // 5. Global tag metadata
  tags: ["backend-demo", "node-v24", "local"],

  // 6. Worker Execution Options
  worker: {
    concurrency: 50,
    gracefulShutdownMs: 30000,
  },

  // 7. Core logger settings
  logger: { level: "debug", prettify: true },
});
