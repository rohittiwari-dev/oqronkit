import { OqronEventBus } from "../core/index.js";
import type { OqronRegistry } from "../core/registry.js";

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

OqronEventBus.on("job:start", (jobId: string, mod: string) =>
  appendEvent("job:start", { jobId, mod }),
);
OqronEventBus.on("job:success", (jobId: string) =>
  appendEvent("job:success", { jobId }),
);
OqronEventBus.on("job:fail", (jobId: string, err: Error) =>
  appendEvent("job:fail", { jobId, error: err.message }),
);
OqronEventBus.on("system:ready", () => appendEvent("system:ready", {}));
OqronEventBus.on("system:stop", () => appendEvent("system:stop", {}));

// ── Registry reference (set via configureHandlers) ──────────────────────

let _registry: OqronRegistry | null = null;

/**
 * Wire the handler layer to the module registry.
 * Call this after all modules are booted so handleTrigger can
 * look up engines and actually fire schedules.
 */
export function configureHandlers(registry: OqronRegistry): void {
  _registry = registry;
}

// ── Handlers ────────────────────────────────────────────────────────────

export async function handleHealth(
  _req: MonitorRequest,
): Promise<MonitorResponse> {
  return {
    status: 200,
    body: {
      ok: true,
      status: "running",
      uptime: process.uptime(),
      env: process.env.OQRON_ENV ?? "development",
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

  // Try to actually fire the schedule via registered modules
  if (_registry) {
    for (const mod of _registry.getAll()) {
      if (mod.triggerManual) {
        const triggered = await mod.triggerManual(id);
        if (triggered) {
          appendEvent("manual:trigger", { id, executed: true });
          return {
            status: 200,
            body: {
              ok: true,
              message: `Schedule "${id}" triggered successfully.`,
            },
          };
        }
      }
    }
  }

  // Schedule not found in any module
  return {
    status: 404,
    body: {
      ok: false,
      error: `Schedule "${id}" not found in any registered module.`,
    },
  };
}

export async function dispatch(req: MonitorRequest): Promise<MonitorResponse> {
  const { method, path } = req;

  if (method === "GET" && path === "/health") return handleHealth(req);
  if (method === "GET" && path === "/events") return handleEvents(req);
  if (method === "POST" && path.startsWith("/jobs/")) return handleTrigger(req);

  return { status: 404, body: { ok: false, error: "Not found" } };
}
