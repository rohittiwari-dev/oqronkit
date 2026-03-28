import { defineConfig } from "chronoforge";

export default defineConfig({
  // 1. Identification
  project: "backend-api-demo",

  // 2. Environment Isolation
  environment: process.env.CHRONO_ENV ?? "development",

  // 3. Infrastructure setup — declarative auto-resolution
  db: {
    adapter: "memory",
  },
  lock: {
    adapter: "memory",
  },

  // 4. Enabled Modules
  modules: ["cron", "scheduler"],

  // 5. Global tag metadata
  tags: ["backend-demo", "node-v24", "local"],

  // 6. Worker Execution Options
  worker: {
    concurrency: 50,
    gracefulShutdownMs: 30000,
  },

  // 7. Core logger settings
  logger: {
    enabled: true,
    level: "debug",
    prettify: true,
    redact: ["password", "token", "userId"],
  },

  // 8. Graceful Shutdown
  shutdown: {
    enabled: true,
    timeout: 30000,
  },
});
