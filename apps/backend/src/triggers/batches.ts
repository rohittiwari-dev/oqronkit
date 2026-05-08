/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  OqronKit — Batch Module Examples
 *  Real-world production examples showcasing the batch() API.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *  batch() accumulates items in a persistent buffer and flushes them as a group
 *  when either `maxSize` or `maxWaitMs` is reached — whichever comes first.
 *
 *  Features demonstrated:
 *  ✓ maxSize / maxWaitMs flush triggers
 *  ✓ groupBy — separate buffers per dynamic key
 *  ✓ deduplicateBy — content-based dedup within a buffer window
 *  ✓ Typed payloads
 *  ✓ Crash-safe persistent buffer (survives restarts)
 *  ✓ Retry + DLQ on handler failure
 *  ✓ Progress tracking via ctx.progress()
 *  ✓ Structured logging via ctx.log
 *  ✓ Concurrency limits
 *  ✓ Lifecycle hooks (beforeFlush, onSuccess, onFail)
 */

import { batch } from "oqronkit";

// ─────────────────────────────────────────────────────────────────────────────
// 1. ANALYTICS EVENT BATCH
//    Buffer analytics events and flush to warehouse in bulk.
//    maxSize: 100 events per batch, OR maxWaitMs: 5 seconds (whichever first)
// ─────────────────────────────────────────────────────────────────────────────
type AnalyticsEvent = {
  eventName: string;
  userId: string;
  properties: Record<string, unknown>;
  timestamp: string;
};

export const analyticsBatch = batch<AnalyticsEvent>({
  name: "analytics-events",

  maxSize: 100,
  maxWaitMs: 5_000,

  concurrency: 3,
  guaranteedWorker: true,

  // Content-based dedup: same userId + eventName within a buffer window is dropped
  deduplicateBy: (item) => `${item.userId}:${item.eventName}`,

  retries: {
    max: 2,
    strategy: "exponential",
    baseDelay: 3000,
  },

  deadLetter: {
    enabled: true,
    onDead: async (job) => {
      console.error(
        `☠️ Analytics batch permanently failed — ${job.data.items.length} events lost`,
      );
    },
  },

  hooks: {
    beforeFlush: async (items, groupKey) => {
      console.log(
        `📊 [beforeFlush] Preparing ${items.length} events (group: ${groupKey ?? "default"})`,
      );
      // Filter out test events before flushing
      return items.filter((e) => !e.userId.startsWith("test_"));
    },
    onSuccess: async (_job, result) => {
      console.log(`✅ Analytics batch flushed:`, result);
    },
    onFail: async (job, error) => {
      console.error(
        `❌ Analytics batch failed (${job.data.items.length} events): ${error.message}`,
      );
    },
  },

  handler: async (ctx) => {
    const events = ctx.batch;
    ctx.log.info(`📊 Flushing ${ctx.batchSize} analytics events`);

    ctx.progress(20, "Serializing events to columnar format");
    await new Promise((r) => setTimeout(r, 100));

    if (ctx.signal.aborted) {
      ctx.log.warn("Batch processing aborted");
      return { ingested: 0, warehouse: "aborted" };
    }

    ctx.progress(60, "Writing batch to ClickHouse");
    await new Promise((r) => setTimeout(r, 200));

    ctx.progress(100, "Batch ingested successfully");
    return { ingested: events.length, warehouse: "clickhouse" };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. LOG AGGREGATION BATCH — Grouped by service name
//    Uses groupBy to create separate buffers per service.
//    Each service's logs are flushed independently.
// ─────────────────────────────────────────────────────────────────────────────
type LogEntry = {
  service: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  metadata: Record<string, unknown>;
  timestamp: string;
};

export const logBatch = batch<LogEntry>({
  name: "log-aggregation",

  maxSize: 50,
  maxWaitMs: 10_000,

  // ── Group by service name ──
  // Creates independent buffers: "api-gateway", "auth-service", "payment-service"
  // Each buffer flushes separately when its own maxSize/maxWaitMs is reached.
  groupBy: (item) => item.service,

  concurrency: 5,

  retries: {
    max: 1,
    strategy: "fixed",
    baseDelay: 2000,
  },

  handler: async (ctx) => {
    const logs = ctx.batch;
    const service = logs[0]?.service ?? "unknown";
    ctx.log.info(`📋 Flushing ${ctx.batchSize} logs for service: ${service}`);

    if (ctx.groupKey) {
      ctx.log.info(`Group key: ${ctx.groupKey}`);
    }

    ctx.progress(30, "Formatting log entries");
    await new Promise((r) => setTimeout(r, 50));

    ctx.progress(70, `Shipping to Elasticsearch index: logs-${service}`);
    await new Promise((r) => setTimeout(r, 100));

    ctx.progress(100, "Logs shipped");
    return { shipped: logs.length, service, index: `logs-${service}` };
  },
});
