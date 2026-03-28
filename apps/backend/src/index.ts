/**
 * Main entry for the OqronKit backend demo.
 * Uses Express.js — swap the import block for Fastify/Hono as needed.
 */

import { mkdirSync } from "node:fs";
import express from "express";
import { OqronKit } from "oqronkit";

// ─── 1. Prepare DB directory ──────────────────────────────────────────────────
mkdirSync("data", { recursive: true });

// ─── 2. Bootstrap OqronKit ──────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("Booting OqronKit…");

  // Zero boilerplate: reads oqronkit.config.js, uses jobsDir to load crons
  await OqronKit.init({
    config: {
      modules: ["cron", "scheduler"],
      logger: {
        prettify: true,
      },
    },
  });

  // Test dynamic schedule triggers!
  const { scheduleOnboardingDrip } = await import("./jobs/scheduler.js");
  await scheduleOnboardingDrip("u_" + Math.random().toString(36).slice(2, 8));

  // ─── 3. Express HTTP server ──────────────────────────────────────────────────
  const app = express();
  app.use(express.json());

  // Mount OqronKit monitoring routes cleanly
  app.use("/api/chrono", OqronKit.expressRouter());

  // Root info
  app.get("/", (_req, res) => {
    res.json({
      name: "OqronKit Backend Demo",
      version: "0.0.1",
      docs: {
        health: "GET  /api/chrono/health",
        events: "GET  /api/chrono/events?limit=50",
        trigger: "POST /api/chrono/jobs/:id/trigger",
      },
    });
  });

  const PORT = Number(process.env.PORT ?? 3000);
  app.listen(PORT, () => {
    console.log(`Server ready on http://localhost:${PORT}`);
  });
}

main().catch((err: unknown) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
