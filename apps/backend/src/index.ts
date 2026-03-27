/**
 * Main entry for the ChronoForge backend demo.
 * Uses Express.js — swap the import block for Fastify/Hono as needed.
 *
 * Node.js runtime:  tsx src/index.ts  |  ts-node src/index.ts
 * Bun runtime:      bun run src/index.ts
 * Deno runtime:     deno run -A src/index.ts
 */

import { mkdirSync } from "node:fs";
import { ChronoEventBus, createLogger } from "@chronoforge/core";
import { ChronoForge } from "chronoforge";
import express from "express";

const log = createLogger({ level: "debug" });
log.info("ChronoForge backend starting");

// ─── 1. Prepare DB directory ──────────────────────────────────────────────────
mkdirSync("data", { recursive: true });

// ─── 2. Bootstrap ChronoForge ──────────────────────────────────────────────────
async function main(): Promise<void> {
  log.info("Booting ChronoForge…");

  // Zero boilerplate: reads chronoforge.config.js, uses jobsDir to load crons
  await ChronoForge.init({
    cwd: process.cwd(),
  });

  // ─── 3. Express HTTP server ──────────────────────────────────────────────────
  const app = express();
  app.use(express.json());

  // Mount ChronoForge monitoring routes cleanly
  app.use("/api/chrono", ChronoForge.expressRouter());

  // Root info
  app.get("/", (_req, res) => {
    res.json({
      name: "ChronoForge Backend Demo",
      version: "0.0.1",
      docs: {
        health: "GET  /api/chrono/health",
        events: "GET  /api/chrono/events?limit=50",
        trigger: "POST /api/chrono/jobs/:id/trigger",
      },
    });
  });

  const PORT = Number(process.env.PORT ?? 3000);
  const server = app.listen(PORT, () => {
    log.info(`Server ready on http://localhost:${PORT}`);
    ChronoEventBus.emit("system:ready");
  });

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    log.info(`${signal} received — shutting down…`);
    server.close();
    await ChronoForge.stop();
    ChronoEventBus.emit("system:stop");
    log.info("Bye!");
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch((err: unknown) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
