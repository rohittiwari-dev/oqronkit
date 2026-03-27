/**
 * Framework-agnostic HTTP handlers for ChronoForge monitoring.
 *
 * These handlers work with a plain { method, path, query } request and return
 * a plain { status, body } response — no framework dependency at all.
 * They get wrapped by framework-specific adapters (express.ts, fastify.ts, hono.ts, nest.ts).
 */

import { ChronoEventBus } from "@chronoforge/core";

type MonitorRequest = {
  method: string;
  path: string;
  query: Record<string, string>;
  params: Record<string, string>;
};

type MonitorResponse = {
  status: number;
  body: unknown;
};

// In-memory rolling event log — swap for DB/Redis in production
const recentEvents: Array<{ ts: string; event: string; data: unknown }> = [];

function appendEvent(event: string, data: unknown): void {
  recentEvents.unshift({ ts: new Date().toISOString(), event, data });
  if (recentEvents.length > 500) recentEvents.pop();
}

// Subscribe to all internal framework events
ChronoEventBus.on("job:start", (jobId: string, mod: string) =>
  appendEvent("job:start", { jobId, mod }),
);
ChronoEventBus.on("job:success", (jobId: string) =>
  appendEvent("job:success", { jobId }),
);
ChronoEventBus.on("job:fail", (jobId: string, err: Error) =>
  appendEvent("job:fail", { jobId, error: err.message }),
);
ChronoEventBus.on("system:ready", () => appendEvent("system:ready", {}));
ChronoEventBus.on("system:stop", () => appendEvent("system:stop", {}));

/** GET /api/chrono/health */
export async function handleHealth(
  _req: MonitorRequest,
): Promise<MonitorResponse> {
  return {
    status: 200,
    body: {
      ok: true,
      status: "running",
      uptime: process.uptime(),
      env: process.env.CHRONO_ENV ?? "development",
      ts: new Date().toISOString(),
    },
  };
}

/** GET /api/chrono/events?limit=50 */
export async function handleEvents(
  req: MonitorRequest,
): Promise<MonitorResponse> {
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  return {
    status: 200,
    body: { ok: true, events: recentEvents.slice(0, limit) },
  };
}

/** POST /api/chrono/jobs/:id/trigger */
export async function handleTrigger(
  req: MonitorRequest,
): Promise<MonitorResponse> {
  const id = req.params.id;
  if (!id)
    return { status: 400, body: { ok: false, error: "Missing :id param" } };
  appendEvent("manual:trigger", { id });
  // TODO: wire to SchedulerModule.triggerNow(id) when implemented
  return {
    status: 200,
    body: { ok: true, message: `Trigger queued for "${id}"` },
  };
}

/** Route dispatcher — call from any framework adapter */
export async function dispatch(req: MonitorRequest): Promise<MonitorResponse> {
  const { method, path } = req;

  if (method === "GET" && path === "/health") return handleHealth(req);
  if (method === "GET" && path === "/events") return handleEvents(req);
  if (method === "POST" && path.startsWith("/jobs/")) return handleTrigger(req);

  return { status: 404, body: { ok: false, error: "Not found" } };
}
