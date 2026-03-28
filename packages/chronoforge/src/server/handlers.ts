import { ChronoEventBus } from "../core/index.js";

export type MonitorRequest = {
  method: string;
  path: string;
  query: Record<string, string>;
  params: Record<string, string>;
};

export type MonitorResponse = {
  status: number;
  body: unknown;
};

// In-memory rolling event log
const recentEvents: Array<{ ts: string; event: string; data: unknown }> = [];

function appendEvent(event: string, data: unknown): void {
  recentEvents.unshift({ ts: new Date().toISOString(), event, data });
  if (recentEvents.length > 500) recentEvents.pop();
}

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

export async function handleEvents(
  req: MonitorRequest,
): Promise<MonitorResponse> {
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  return {
    status: 200,
    body: { ok: true, events: recentEvents.slice(0, limit) },
  };
}

export async function handleTrigger(
  req: MonitorRequest,
): Promise<MonitorResponse> {
  const id = req.params.id;
  if (!id)
    return { status: 400, body: { ok: false, error: "Missing :id param" } };
  appendEvent("manual:trigger", { id });
  return {
    status: 200,
    body: { ok: true, message: `Trigger queued for "${id}"` },
  };
}

export async function dispatch(req: MonitorRequest): Promise<MonitorResponse> {
  const { method, path } = req;

  if (method === "GET" && path === "/health") return handleHealth(req);
  if (method === "GET" && path === "/events") return handleEvents(req);
  if (method === "POST" && path.startsWith("/jobs/")) return handleTrigger(req);

  return { status: 404, body: { ok: false, error: "Not found" } };
}
