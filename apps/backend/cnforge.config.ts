import { defineConfig } from "chronoforge";

export default defineConfig({
  environment: process.env.CHRONO_ENV ?? "development",
  db: {
    type: "sqlite",
    url: "data/chrono.sqlite",
  },
  lock: { type: "db" },
  logger: { level: "debug" },
});
