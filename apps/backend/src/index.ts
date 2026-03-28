/**
 * Main entry for the ChronoForge backend demo.
 * Uses Express.js — swap the import block for Fastify/Hono as needed.
 */

import { mkdirSync } from "node:fs";
import { ChronoForge } from "chronoforge";
import express from "express";

// ─── 1. Prepare DB directory ──────────────────────────────────────────────────
mkdirSync("data", { recursive: true });

// ─── 2. Bootstrap ChronoForge ──────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("Booting ChronoForge…");

  // Zero boilerplate: reads chronoforge.config.js, uses jobsDir to load crons
  await ChronoForge.init({ cwd: process.cwd() });

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
    console.log(`Server ready on http://localhost:${PORT}`);
  });

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`${signal} received — shutting down…`);
    server.close();
    await ChronoForge.stop();
    console.log("Bye!");
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
