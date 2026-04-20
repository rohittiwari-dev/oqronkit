import { EventEmitter } from "eventemitter3";

export type OqronEventMap = {
  // ── Job lifecycle ────────────────────────────────────────────────────────
  "job:start": [queueName: string, jobId: string, module: string];
  "job:progress": [queueName: string, jobId: string, value: number];
  "job:success": [queueName: string, jobId: string];
  "job:fail": [queueName: string, jobId: string, error: Error];
  "job:cancelled": [queueName: string, jobId: string];
  "job:stalled": [queueName: string, jobId: string];
  "job:retried": [jobId: string, retryId: string];

  // ── Module lifecycle ──────────────────────────────────────────────────────
  "module:enabled": [moduleName: string];
  "module:disabled": [moduleName: string];

  // ── Schedule instance lifecycle ───────────────────────────────────────────
  "schedule:paused": [scheduleName: string];
  "schedule:resumed": [scheduleName: string];
  "schedule:version-upgraded": [scheduleName: string, fromVersion: number, toVersion: number];

  // ── Schedule CRUD (G1) ─────────────────────────────────────────────────────
  "schedule:created": [scheduleName: string, type: "cron" | "schedule"];
  "schedule:updated": [scheduleName: string, type: "cron" | "schedule"];
  "schedule:deleted": [scheduleName: string, type: "cron" | "schedule"];

  // ── Schedule Fire Lifecycle (G6 — Metrics) ─────────────────────────────────
  "schedule:fire:start": [scheduleName: string, runId: string, type: "cron" | "schedule"];
  "schedule:fire:complete": [scheduleName: string, runId: string, status: "completed" | "failed", durationMs: number];
  "schedule:rate-limited": [scheduleName: string];

  // ── System ───────────────────────────────────────────────────────────────
  "system:ready": [];
  "system:stop": [];

  // ── Rate Limit — Core ────────────────────────────────────────────────────
  "ratelimit:blocked": [limiterName: string, tier: string, key: string, result: any];
  "ratelimit:warning": [limiterName: string, tier: string, key: string, percent: number];
  "ratelimit:banned": [limiterName: string, tier: string, key: string, banDurationMs: number];
  "ratelimit:unbanned": [limiterName: string, tier: string, key: string];
  "ratelimit:override": [limiterName: string, key: string, override: { max: number }];

  // ── Rate Limit — Management ──────────────────────────────────────────────
  "ratelimit:instance:enabled": [limiterName: string];
  "ratelimit:instance:disabled": [limiterName: string];
  "ratelimit:instance:created": [limiterName: string, algorithm: string, tiers: string[]];

  // ── Rate Limit — Magic Features ──────────────────────────────────────────
  "ratelimit:suggestion": [limiterName: string, tier: string, suggestedMax: number, currentP95: number];
  "ratelimit:circuit-open": [limiterName: string, tier: string, key: string, burstMultiplier: number];
  "ratelimit:circuit-closed": [limiterName: string, tier: string, key: string];

  // ── Queue Lifecycle (Phase 4 — Dynamic CRUD) ──────────────────────────────
  "queue:registered": [queueName: string];
  "queue:deregistered": [queueName: string];
  "queue:paused": [queueName: string];
  "queue:resumed": [queueName: string];
  "queue:drained": [queueName: string];
  "queue:obliterated": [queueName: string, jobsRemoved: number];

  // ── Worker Lifecycle (Phase 4 — Dynamic CRUD) ─────────────────────────────
  "worker:registered": [topic: string];
  "worker:deregistered": [topic: string];
  "worker:paused": [topic: string];
  "worker:resumed": [topic: string];

  // ── Queue/Worker Metrics Lifecycle (Phase 5 — G6 Parity) ──────────────────
  "queue:job:claimed": [queueName: string, jobId: string];
  "queue:job:completed": [queueName: string, jobId: string, durationMs: number];
  "queue:job:failed": [queueName: string, jobId: string, durationMs: number];
  "worker:job:claimed": [topic: string, jobId: string];
  "worker:job:completed": [topic: string, jobId: string, durationMs: number];
  "worker:job:failed": [topic: string, jobId: string, durationMs: number];
};

class OqronEventBusClass extends EventEmitter<OqronEventMap> {
  private static _instance: OqronEventBusClass;
  static getInstance(): OqronEventBusClass {
    if (!OqronEventBusClass._instance) {
      OqronEventBusClass._instance = new OqronEventBusClass();
    }
    return OqronEventBusClass._instance;
  }
}

export const OqronEventBus = OqronEventBusClass.getInstance();

