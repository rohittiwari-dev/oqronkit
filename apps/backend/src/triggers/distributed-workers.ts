/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  OqronKit — Distributed Queue + Worker Examples
 *  Real-world production examples showcasing decoupled Queue/Worker architecture.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *  Queue/Worker vs. taskQueue:
 *  • Queue    → Pure publisher (sender). Consumes ZERO CPU/polling.
 *                Lives in your API server pods.
 *  • Worker   → Pure consumer (processor). Polls the broker for work.
 *                Lives in dedicated worker pods, horizontally scaled.
 *
 *  This separation means your API server can push 100k jobs/sec onto the
 *  queue without any local processing overhead.
 *
 *  Features demonstrated:
 *  ✓ Queue.add() — publish jobs
 *  ✓ Queue.addBulk() — batch publish
 *  ✓ Worker — processor functions
 *  ✓ Worker hooks (onSuccess, onFail)
 *  ✓ Worker concurrency and rate limiting
 *  ✓ QueueEvents — real-time event streaming (active, progress, completed, failed)
 *  ✓ Delay support
 *  ✓ Custom jobId (idempotency)
 */

import { OqronEventBus } from "oqronkit";

// ═══════════════════════════════════════════════════════════════════════════════
//  4. GLOBAL EVENT BUS — Cross-cutting telemetry
//     OqronEventBus hooks for system-wide observability
// ═══════════════════════════════════════════════════════════════════════════════

// Log every job start across ALL queues
OqronEventBus.on("job:start", (queueName, jobId, module) => {
  console.log(
    `[TELEMETRY] Job started — queue: ${queueName}, id: ${jobId}, module: ${module}`,
  );
});

// Log every job failure across ALL queues
OqronEventBus.on("job:fail", (queueName, jobId, error) => {
  console.error(
    `[TELEMETRY] Job failed — queue: ${queueName}, id: ${jobId}, error: ${error.message}`,
  );
});
