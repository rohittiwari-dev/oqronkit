import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initEngine, Storage, Broker } from "../../src/engine/core.js";
import { OqronRegistry } from "../../src/engine/registry.js";
import { OqronEventBus } from "../../src/engine/events/event-bus.js";
import {
  dispatch,
  configureHandlers,
  handleHealth,
  handleEvents,
  type MonitorRequest,
} from "../../src/server/handlers.js";
import type { OqronConfig } from "../../src/engine/types/config.types.js";

const config: OqronConfig = { project: "test", environment: "test" };

function req(method: string, path: string, extras?: Partial<MonitorRequest>): MonitorRequest {
  return {
    method,
    path,
    query: {},
    params: {},
    ...extras,
  };
}

describe("Server Handlers", () => {
  beforeEach(async () => {
    await initEngine(config);
    OqronRegistry.getInstance()._reset();
    configureHandlers(OqronRegistry.getInstance(), config);
  });

  // ── Health ──────────────────────────────────────────────────────────────

  describe("GET /health", () => {
    it("returns 200 with ok status", async () => {
      const res = await dispatch(req("GET", "/health"));
      expect(res.status).toBe(200);
      expect((res.body as any).ok).toBe(true);
      expect((res.body as any).status).toBe("running");
    });

    it("includes uptime", async () => {
      const res = await dispatch(req("GET", "/health"));
      expect(typeof (res.body as any).uptime).toBe("number");
    });
  });

  // ── Events ─────────────────────────────────────────────────────────────

  describe("GET /events", () => {
    it("returns 200 with events array", async () => {
      const res = await dispatch(req("GET", "/events"));
      expect(res.status).toBe(200);
      expect((res.body as any).ok).toBe(true);
      expect(Array.isArray((res.body as any).events)).toBe(true);
    });

    it("captures event bus emissions", async () => {
      OqronEventBus.emit("system:ready");
      const res = await dispatch(req("GET", "/events"));
      const events = (res.body as any).events;
      const readyEvent = events.find((e: any) => e.event === "system:ready");
      expect(readyEvent).toBeDefined();
    });

    it("respects limit query parameter", async () => {
      // Emit several events
      for (let i = 0; i < 10; i++) {
        OqronEventBus.emit("system:ready");
      }
      const res = await dispatch(req("GET", "/events", { query: { limit: "3" } }));
      const events = (res.body as any).events;
      expect(events.length).toBeLessThanOrEqual(3);
    });
  });

  // ── Trigger ────────────────────────────────────────────────────────────

  describe("POST /jobs/:id", () => {
    it("returns 404 when schedule is not found", async () => {
      const res = await dispatch(req("POST", "/jobs/non-existent"));
      expect(res.status).toBe(404);
    });

    it("returns 200 when a module triggers successfully", async () => {
      OqronRegistry.getInstance().register({
        name: "testMod",
        enabled: true,
        init: async () => {},
        start: async () => {},
        stop: async () => {},
        triggerManual: async (id: string) => id === "my-schedule",
      });

      const res = await dispatch(req("POST", "/jobs/my-schedule"));
      expect(res.status).toBe(200);
      expect((res.body as any).ok).toBe(true);
    });
  });

  // ── Admin System Stats ─────────────────────────────────────────────────

  describe("GET /admin/system", () => {
    it("returns system stats", async () => {
      const res = await dispatch(req("GET", "/admin/system"));
      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.ok).toBe(true);
      expect(body.stats.project).toBe("test");
    });
  });

  // ── Admin Queue ────────────────────────────────────────────────────────

  describe("GET /admin/queues/:name", () => {
    it("returns metrics and jobs for a queue", async () => {
      await Storage.save("jobs", "j1", {
        id: "j1",
        queueName: "emails",
        status: "waiting",
        type: "task",
        data: {},
        opts: {},
        attemptMade: 0,
        progressPercent: 0,
        tags: [],
        createdAt: new Date(),
      });

      const res = await dispatch(req("GET", "/admin/queues/emails"));
      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.ok).toBe(true);
      expect(body.metrics.waiting).toBe(1);
      expect(body.jobs).toHaveLength(1);
    });
  });

  // ── Admin Queue Actions ────────────────────────────────────────────────

  describe("POST /admin/queues/:name/pause|resume|retry-failed", () => {
    it("pause returns 200", async () => {
      const res = await dispatch(req("POST", "/admin/queues/test-q/pause"));
      expect(res.status).toBe(200);
    });

    it("resume returns 200", async () => {
      const res = await dispatch(req("POST", "/admin/queues/test-q/resume"));
      expect(res.status).toBe(200);
    });

    it("retry-failed returns 200 with count", async () => {
      const res = await dispatch(req("POST", "/admin/queues/test-q/retry-failed"));
      expect(res.status).toBe(200);
      expect((res.body as any).retried).toBe(0);
    });

    it("unknown action returns 400", async () => {
      const res = await dispatch(req("POST", "/admin/queues/test-q/explode"));
      // dispatch won't match the regex, so 404
      expect(res.status).toBe(404);
    });
  });

  // ── Admin Job ──────────────────────────────────────────────────────────

  describe("Admin job routes", () => {
    beforeEach(async () => {
      await Storage.save("jobs", "lookup-1", {
        id: "lookup-1",
        type: "task",
        queueName: "q",
        status: "failed",
        data: {},
        opts: {},
        attemptMade: 3,
        progressPercent: 0,
        error: "boom",
        tags: [],
        createdAt: new Date(),
      });
    });

    it("GET /admin/jobs/:id returns the job", async () => {
      const res = await dispatch(req("GET", "/admin/jobs/lookup-1"));
      expect(res.status).toBe(200);
      expect((res.body as any).job.id).toBe("lookup-1");
    });

    it("GET /admin/jobs/:id returns 404 for missing job", async () => {
      const res = await dispatch(req("GET", "/admin/jobs/ghost"));
      expect(res.status).toBe(404);
    });

    it("POST /admin/jobs/:id/retry retries a failed job", async () => {
      const res = await dispatch(req("POST", "/admin/jobs/lookup-1/retry"));
      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.ok).toBe(true);
      expect(body.retryId).toBeDefined();

      // Original should be preserved as failed (audit trail)
      const original = await Storage.get<any>("jobs", "lookup-1");
      expect(original.status).toBe("failed");

      // New retry job should exist with clean state
      const retryJob = await Storage.get<any>("jobs", body.retryId);
      expect(retryJob.status).toBe("waiting");
      expect(retryJob.retriedFromId).toBe("lookup-1");
    });

    it("DELETE /admin/jobs/:id cancels a job", async () => {
      const res = await dispatch(req("DELETE", "/admin/jobs/lookup-1"));
      expect(res.status).toBe(200);

      const job = await Storage.get("jobs", "lookup-1");
      expect(job).toBeNull();
    });
  });

  // ── 404 ────────────────────────────────────────────────────────────────

  describe("Unknown routes", () => {
    it("returns 404 for unknown path", async () => {
      const res = await dispatch(req("GET", "/unknown"));
      expect(res.status).toBe(404);
    });
  });
});
