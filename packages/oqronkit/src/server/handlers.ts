import { OqronEventBus, type OqronJob } from "../engine/index.js";
import type { OqronRegistry } from "../engine/registry.js";
import type { OqronConfig } from "../engine/types/config.types.js";
import { OqronManager } from "../manager/oqron-manager.js";
export type MonitorRequest = {
  method: string;
  path: string;
  query: Record<string, string>;
  params: Record<string, string>;
  body?: unknown;
};

export type MonitorResponse = {
  status: number;
  body: unknown;
};

// ── In-memory rolling event log ──────────────────────────────────────────────

const recentEvents: Array<{ ts: string; event: string; data: unknown }> = [];

function appendEvent(event: string, data: unknown): void {
  recentEvents.unshift({ ts: new Date().toISOString(), event, data });
  if (recentEvents.length > 500) recentEvents.pop();
}

OqronEventBus.on("job:start", (queueName: string, jobId: string, mod: string) =>
  appendEvent("job:start", { queueName, jobId, mod }),
);
OqronEventBus.on("job:success", (queueName: string, jobId: string) =>
  appendEvent("job:success", { queueName, jobId }),
);
OqronEventBus.on("job:fail", (queueName: string, jobId: string, err: Error) =>
  appendEvent("job:fail", { queueName, jobId, error: err.message }),
);
OqronEventBus.on("system:ready", () => appendEvent("system:ready", {}));
OqronEventBus.on("system:stop", () => appendEvent("system:stop", {}));

// ── Registry + Config reference ───────────────────────────────────────────────

let _registry: OqronRegistry | null = null;
let _config: OqronConfig | null = null;

/**
 * Wire the handler layer to the module registry.
 * Call this after all modules are booted.
 */
export function configureHandlers(
  registry: OqronRegistry,
  config?: OqronConfig,
): void {
  _registry = registry;
  if (config) _config = config;
}

// ── Core Handlers ────────────────────────────────────────────────────────────

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

  return {
    status: 404,
    body: {
      ok: false,
      error: `Schedule "${id}" not found in any registered module.`,
    },
  };
}

// ── Admin Handlers ─────────────────────────────────────────────────────────

function getManager(): OqronManager | null {
  if (!_config) return null;
  return OqronManager.from(_config);
}

export async function handleAdminSystem(
  _req: MonitorRequest,
): Promise<MonitorResponse> {
  const mgr = getManager();
  if (!mgr)
    return {
      status: 503,
      body: {
        ok: false,
        error: "Manager not initialized — pass config to configureHandlers()",
      },
    };
  const stats = await mgr.getSystemStats();
  return { status: 200, body: { ok: true, stats } };
}

export async function handleAdminQueue(
  req: MonitorRequest,
): Promise<MonitorResponse> {
  const mgr = getManager();
  if (!mgr)
    return {
      status: 503,
      body: { ok: false, error: "Manager not initialized" },
    };
  const name = req.params.name;
  if (!name)
    return { status: 400, body: { ok: false, error: "Missing queue name" } };
  const state = req.query.state as OqronJob["status"] | undefined;
  const limit = Number(req.query.limit ?? 50);
  const info = await mgr.getQueueInfo(name, { state, limit });
  return { status: 200, body: { ok: true, ...info } };
}

export async function handleAdminQueueAction(
  req: MonitorRequest,
): Promise<MonitorResponse> {
  const mgr = getManager();
  if (!mgr)
    return {
      status: 503,
      body: { ok: false, error: "Manager not initialized" },
    };
  const { name, action } = req.params;

  if (action === "pause") {
    await mgr.pauseQueue(name);
    return { status: 200, body: { ok: true } };
  }
  if (action === "resume") {
    await mgr.resumeQueue(name);
    return { status: 200, body: { ok: true } };
  }
  if (action === "retry-failed") {
    const count = await mgr.retryAllFailed(name);
    return { status: 200, body: { ok: true, retried: count } };
  }
  return {
    status: 400,
    body: { ok: false, error: `Unknown action: ${action}` },
  };
}

export async function handleAdminJob(
  req: MonitorRequest,
): Promise<MonitorResponse> {
  const mgr = getManager();
  if (!mgr)
    return {
      status: 503,
      body: { ok: false, error: "Manager not initialized" },
    };
  const { id, action } = req.params;

  if (req.method === "GET") {
    const job = await mgr.getJob(id);
    if (!job)
      return { status: 404, body: { ok: false, error: "Job not found" } };
    return { status: 200, body: { ok: true, job } };
  }
  if (action === "retry") {
    await mgr.retryJob(id);
    return { status: 200, body: { ok: true } };
  }
  if (req.method === "DELETE") {
    await mgr.cancelJob(id);
    return { status: 200, body: { ok: true } };
  }
  return { status: 400, body: { ok: false, error: "Unknown operation" } };
}

// ── Unified Dispatcher ────────────────────────────────────────────────────────

export async function dispatch(req: MonitorRequest): Promise<MonitorResponse> {
  const { method, path } = req;

  // Core routes
  if (method === "GET" && path === "/health") return handleHealth(req);
  if (method === "GET" && path === "/events") return handleEvents(req);
  if (method === "POST" && path.startsWith("/jobs/")) {
    const id = path.split("/jobs/")[1];
    req.params = { ...req.params, id };
    return handleTrigger(req);
  }

  // ── Admin Routes ────────────────────────────────────────────────────────
  // GET  /admin/system
  if (method === "GET" && path === "/admin/system")
    return handleAdminSystem(req);

  // GET  /admin/queues/:name[?state=failed&limit=50]
  const queueMatch = path.match(/^\/admin\/queues\/([^/]+)$/);
  if (queueMatch) {
    req.params = { ...req.params, name: queueMatch[1] };
    return handleAdminQueue(req);
  }

  // POST /admin/queues/:name/(pause|resume|retry-failed)
  const queueActionMatch = path.match(
    /^\/admin\/queues\/([^/]+)\/(pause|resume|retry-failed)$/,
  );
  if (queueActionMatch && method === "POST") {
    req.params = {
      ...req.params,
      name: queueActionMatch[1],
      action: queueActionMatch[2],
    };
    return handleAdminQueueAction(req);
  }

  // GET  /admin/jobs/:id
  // POST /admin/jobs/:id/retry
  // DELETE /admin/jobs/:id
  const jobMatch = path.match(/^\/admin\/jobs\/([^/]+)(?:\/(retry))?$/);
  if (jobMatch) {
    req.params = { ...req.params, id: jobMatch[1], action: jobMatch[2] ?? "" };
    return handleAdminJob(req);
  }

  return { status: 404, body: { ok: false, error: "Not found" } };
}
