import { timingSafeEqual } from "node:crypto";
import { OqronEventBus, type OqronJob } from "../engine/index.js";
import type { OqronRegistry } from "../engine/registry.js";
import type { OqronConfig } from "../engine/types/config.types.js";
import { OqronManager } from "../manager/oqron-manager.js";
import { getLimiter } from "../ratelimit/registry.js";
export type MonitorRequest = {
  method: string;
  path: string;
  query: Record<string, string>;
  params: Record<string, string>;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
};

export type MonitorResponse = {
  status: number;
  headers?: Record<string, string>;
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
  _manager = null;
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

let _manager: OqronManager | null = null;
function getManager(): OqronManager | null {
  if (!_config) return null;
  if (!_manager) {
    _manager = OqronManager.from(_config);
  }
  return _manager;
}

function firstHeader(
  headers: MonitorRequest["headers"] | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    if (Array.isArray(value)) return value[0];
    return value;
  }
  return undefined;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function isAuthorized(req: MonitorRequest): boolean {
  const auth = _config?.ui?.auth;
  if (!auth?.username && !auth?.password) return true;

  const expectedUser = auth.username ?? "";
  const expectedPass = auth.password ?? "";
  const header = firstHeader(req.headers, "authorization");
  if (!header?.startsWith("Basic ")) return false;

  let decoded = "";
  try {
    decoded = Buffer.from(header.slice("Basic ".length), "base64").toString(
      "utf8",
    );
  } catch {
    return false;
  }

  const separator = decoded.indexOf(":");
  if (separator === -1) return false;
  const user = decoded.slice(0, separator);
  const pass = decoded.slice(separator + 1);
  return constantTimeEqual(user, expectedUser) && constantTimeEqual(pass, expectedPass);
}

function unauthorized(): MonitorResponse {
  return {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="OqronKit"' },
    body: { ok: false, error: "Unauthorized" },
  };
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

export async function handleAdminModule(
  req: MonitorRequest,
): Promise<MonitorResponse> {
  const mgr = getManager();
  if (!mgr)
    return {
      status: 503,
      body: { ok: false, error: "Manager not initialized" },
    };
  const { name, action } = req.params;

  if (action === "enable") {
    const success = await mgr.enableModule(name);
    return { status: success ? 200 : 404, body: { ok: success } };
  }
  if (action === "disable") {
    const success = await mgr.disableModule(name);
    return { status: success ? 200 : 404, body: { ok: success } };
  }
  return {
    status: 400,
    body: { ok: false, error: `Unknown action: ${action}` },
  };
}

export async function handleAdminInstance(
  req: MonitorRequest,
): Promise<MonitorResponse> {
  const mgr = getManager();
  if (!mgr)
    return {
      status: 503,
      body: { ok: false, error: "Manager not initialized" },
    };
  const { type, name, action } = req.params;

  if (action === "enable") {
    const success = await mgr.enableInstance(type as any, name);
    return { status: success ? 200 : 404, body: { ok: success } };
  }
  if (action === "disable") {
    const success = await mgr.disableInstance(type as any, name);
    return { status: success ? 200 : 404, body: { ok: success } };
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
    const retryId = await mgr.retryJob(id);
    if (!retryId)
      return {
        status: 400,
        body: { ok: false, error: "Job not found or not in failed state" },
      };
    return { status: 200, body: { ok: true, retryId } };
  }
  if (action === "rerun") {
    const rerunId = await mgr.rerunJob(id);
    if (!rerunId)
      return { status: 400, body: { ok: false, error: "Job not found" } };
    return { status: 200, body: { ok: true, rerunId } };
  }
  if (action === "chain") {
    const chain = await mgr.getRetryChain(id);
    return { status: 200, body: { ok: true, chain } };
  }
  if (req.method === "DELETE") {
    await mgr.cancelJob(id);
    return { status: 200, body: { ok: true } };
  }
  return { status: 400, body: { ok: false, error: "Unknown operation" } };
}

// ── Schedule Handlers ────────────────────────────────────────────────────

export async function handleAdminSchedules(
  req: MonitorRequest,
): Promise<MonitorResponse> {
  const mgr = getManager();
  if (!mgr)
    return { status: 503, body: { ok: false, error: "Manager not initialized" } };

  const { name } = req.params;

  // GET /admin/schedules/:name/history
  if (name && req.params.subResource === "history") {
    const limit = Number(req.query.limit ?? 50);
    const offset = Number(req.query.offset ?? 0);
    const status = req.query.status as any;
    const result = await mgr.getJobHistory(name, { status, limit, offset });
    return { status: 200, body: { ok: true, ...result } };
  }

  // GET /admin/schedules/:name — single schedule detail
  if (name) {
    const detail = await mgr.getScheduleDetail(name);
    if (!detail)
      return { status: 404, body: { ok: false, error: "Schedule not found" } };
    return { status: 200, body: { ok: true, schedule: detail } };
  }

  // GET /admin/schedules — list all
  const type = req.query.type as "cron" | "schedule" | undefined;
  const schedules = await mgr.listSchedules(type ? { type } : undefined);
  return { status: 200, body: { ok: true, schedules } };
}

export async function handleAdminJobsQuery(
  req: MonitorRequest,
): Promise<MonitorResponse> {
  const mgr = getManager();
  if (!mgr)
    return { status: 503, body: { ok: false, error: "Manager not initialized" } };

  const result = await mgr.queryJobs({
    type: req.query.type as any,
    status: req.query.status as any,
    queueName: req.query.queue,
    scheduleId: req.query.schedule,
    limit: Number(req.query.limit ?? 50),
    offset: Number(req.query.offset ?? 0),
  });
  return { status: 200, body: { ok: true, ...result } };
}

// ── Rate Limiter Handlers ───────────────────────────────────────────────

export async function handleAdminRateLimiters(
  req: MonitorRequest,
): Promise<MonitorResponse> {
  const mgr = getManager();
  if (!mgr)
    return { status: 503, body: { ok: false, error: "Manager not initialized" } };

  // GET /admin/ratelimiters — list all
  if (!req.params.name) {
    const limiters = await mgr.listRateLimiters();
    const withStats = await Promise.all(
      limiters.map(async (rec) => ({
        ...rec,
        stats: await mgr.getRateLimiterStats(rec.name),
      })),
    );
    return { status: 200, body: { ok: true, limiters: withStats } };
  }

  const { name } = req.params;

  // POST actions
  if (req.method === "POST") {
    const { action } = req.params;

    if (action === "enable") {
      const ok = await mgr.enableRateLimiter(name);
      return { status: ok ? 200 : 404, body: { ok } };
    }
    if (action === "disable") {
      const ok = await mgr.disableRateLimiter(name);
      return { status: ok ? 200 : 404, body: { ok } };
    }

    // Key-level actions: reset, ban, unban, override
    const { key, keyAction } = req.params;
    if (key && keyAction) {
      const limiter = getLimiter(name);
      if (!limiter)
        return { status: 404, body: { ok: false, error: "Limiter not found" } };

      if (keyAction === "reset") {
        await limiter.reset(key);
        return { status: 200, body: { ok: true } };
      }
      if (keyAction === "ban") {
        const duration = (req.body as any)?.duration;
        await limiter.ban(key, duration);
        return { status: 200, body: { ok: true } };
      }
      if (keyAction === "unban") {
        await limiter.unban(key);
        return { status: 200, body: { ok: true } };
      }
      if (keyAction === "override") {
        const max = (req.body as any)?.max;
        if (typeof max !== "number")
          return { status: 400, body: { ok: false, error: "Missing max" } };
        await limiter.setOverride(key, { max });
        return { status: 200, body: { ok: true } };
      }
    }

    return { status: 400, body: { ok: false, error: "Unknown action" } };
  }

  // DELETE — clear override for a key
  if (req.method === "DELETE" && req.params.key) {
    const limiter = getLimiter(name);
    if (!limiter)
      return { status: 404, body: { ok: false, error: "Limiter not found" } };
    await limiter.clearOverride(req.params.key);
    return { status: 200, body: { ok: true } };
  }

  // GET sub-resources
  const { subResource } = req.params;

  if (subResource === "events") {
    const limit = Number(req.query.limit ?? 50);
    const offset = Number(req.query.offset ?? 0);
    const result = await mgr.getRateLimiterEvents(name, { limit, offset });
    return { status: 200, body: { ok: true, ...result } };
  }

  if (subResource === "keys" && req.params.key) {
    const status = await mgr.getRateLimiterKeyStatus(name, req.params.key);
    if (!status)
      return { status: 404, body: { ok: false, error: "Key not found" } };
    return { status: 200, body: { ok: true, status } };
  }

  if (subResource === "snapshot") {
    const limiter = getLimiter(name);
    if (!limiter)
      return { status: 404, body: { ok: false, error: "Limiter not found" } };
    const snapshot = await limiter.snapshot();
    return { status: 200, body: { ok: true, snapshot } };
  }

  // GET /admin/ratelimiters/:name — detail + stats
  const rec = (await mgr.listRateLimiters()).find((r) => r.name === name);
  if (!rec)
    return { status: 404, body: { ok: false, error: "Limiter not found" } };
  const stats = await mgr.getRateLimiterStats(name);
  return { status: 200, body: { ok: true, limiter: rec, stats } };
}

// ── Webhook Handlers (G12) ────────────────────────────────────────────────

export async function handleAdminWebhooks(
  req: MonitorRequest,
): Promise<MonitorResponse> {
  const mgr = getManager();
  if (!mgr)
    return { status: 503, body: { ok: false, error: "Manager not initialized" } };

  const { name } = req.params;

  // POST actions
  if (req.method === "POST") {
    const { action } = req.params;

    if (action === "pause") {
      const ok = await mgr.pauseWebhookDispatcher(name);
      return { status: ok ? 200 : 404, body: { ok } };
    }
    if (action === "resume") {
      const ok = await mgr.resumeWebhookDispatcher(name);
      return { status: ok ? 200 : 404, body: { ok } };
    }

    // Resend a specific job
    const { jobId } = req.params;
    if (jobId) {
      const newId = await mgr.resendWebhookJob(jobId);
      if (!newId)
        return { status: 404, body: { ok: false, error: "Job not found or not in failed/dead-letter state" } };
      return { status: 200, body: { ok: true, newJobId: newId } };
    }

    return { status: 400, body: { ok: false, error: "Unknown action" } };
  }

  // GET sub-resources
  const { subResource } = req.params;

  if (subResource === "deliveries") {
    const limit = Number(req.query.limit ?? 50);
    const offset = Number(req.query.offset ?? 0);
    const status = req.query.status;
    const result = await mgr.getWebhookDeliveries(name, { status, limit, offset });
    return { status: 200, body: { ok: true, ...result } };
  }

  // GET single dispatcher detail
  if (name) {
    const detail = await mgr.getWebhookDispatcherDetail(name);
    if (!detail)
      return { status: 404, body: { ok: false, error: "Dispatcher not found" } };
    return { status: 200, body: { ok: true, dispatcher: detail } };
  }

  // GET list all dispatchers
  const dispatchers = await mgr.listWebhookDispatchers();
  return { status: 200, body: { ok: true, dispatchers } };
}

// ── Unified Dispatcher ────────────────────────────────────────────────────────

export async function dispatch(req: MonitorRequest): Promise<MonitorResponse> {
  const { method, path } = req;

  // Core routes
  if (method === "GET" && path === "/health") return handleHealth(req);

  if (!isAuthorized(req)) return unauthorized();

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

  // POST /admin/modules/:name/(enable|disable)
  const moduleActionMatch = path.match(
    /^\/admin\/modules\/([^/]+)\/(enable|disable)$/,
  );
  if (moduleActionMatch && method === "POST") {
    req.params = {
      ...req.params,
      name: moduleActionMatch[1],
      action: moduleActionMatch[2],
    };
    return handleAdminModule(req);
  }

  // POST /admin/instances/:type/:name/(enable|disable)
  const instanceActionMatch = path.match(
    /^\/admin\/instances\/([^/]+)\/([^/]+)\/(enable|disable)$/,
  );
  if (instanceActionMatch && method === "POST") {
    req.params = {
      ...req.params,
      type: instanceActionMatch[1],
      name: instanceActionMatch[2],
      action: instanceActionMatch[3],
    };
    return handleAdminInstance(req);
  }

  // GET  /admin/jobs?type=cron&status=failed — query jobs
  if (method === "GET" && path === "/admin/jobs") {
    return handleAdminJobsQuery(req);
  }

  // GET  /admin/schedules
  if (method === "GET" && path === "/admin/schedules") {
    req.params = { ...req.params };
    return handleAdminSchedules(req);
  }

  // GET  /admin/schedules/:name
  const schedDetailMatch = path.match(/^\/admin\/schedules\/([^/]+)$/);
  if (schedDetailMatch && method === "GET") {
    req.params = { ...req.params, name: schedDetailMatch[1] };
    return handleAdminSchedules(req);
  }

  // GET  /admin/schedules/:name/history
  const schedHistoryMatch = path.match(/^\/admin\/schedules\/([^/]+)\/history$/);
  if (schedHistoryMatch && method === "GET") {
    req.params = { ...req.params, name: schedHistoryMatch[1], subResource: "history" };
    return handleAdminSchedules(req);
  }

  // GET  /admin/jobs/:id
  // POST /admin/jobs/:id/(retry|rerun|chain)
  // DELETE /admin/jobs/:id
  const jobMatch = path.match(/^\/admin\/jobs\/([^/]+)(?:\/(retry|rerun|chain))?$/);
  if (jobMatch) {
    req.params = { ...req.params, id: jobMatch[1], action: jobMatch[2] ?? "" };
    return handleAdminJob(req);
  }

  // ── Rate Limiter Routes ──────────────────────────────────────────────────

  // GET  /admin/ratelimiters
  if (method === "GET" && path === "/admin/ratelimiters") {
    req.params = { ...req.params };
    return handleAdminRateLimiters(req);
  }

  // GET  /admin/ratelimiters/:name
  const rlDetailMatch = path.match(/^\/admin\/ratelimiters\/([^/]+)$/);
  if (rlDetailMatch && method === "GET") {
    req.params = { ...req.params, name: rlDetailMatch[1] };
    return handleAdminRateLimiters(req);
  }

  // GET  /admin/ratelimiters/:name/events
  // GET  /admin/ratelimiters/:name/snapshot
  const rlSubMatch = path.match(
    /^\/admin\/ratelimiters\/([^/]+)\/(events|snapshot)$/,
  );
  if (rlSubMatch && method === "GET") {
    req.params = { ...req.params, name: rlSubMatch[1], subResource: rlSubMatch[2] };
    return handleAdminRateLimiters(req);
  }

  // GET  /admin/ratelimiters/:name/keys/:key
  const rlKeyMatch = path.match(
    /^\/admin\/ratelimiters\/([^/]+)\/keys\/([^/]+)$/,
  );
  if (rlKeyMatch && method === "GET") {
    req.params = { ...req.params, name: rlKeyMatch[1], subResource: "keys", key: rlKeyMatch[2] };
    return handleAdminRateLimiters(req);
  }

  // POST /admin/ratelimiters/:name/(enable|disable)
  const rlActionMatch = path.match(
    /^\/admin\/ratelimiters\/([^/]+)\/(enable|disable)$/,
  );
  if (rlActionMatch && method === "POST") {
    req.params = { ...req.params, name: rlActionMatch[1], action: rlActionMatch[2] };
    return handleAdminRateLimiters(req);
  }

  // POST /admin/ratelimiters/:name/keys/:key/(reset|ban|unban|override)
  const rlKeyActionMatch = path.match(
    /^\/admin\/ratelimiters\/([^/]+)\/keys\/([^/]+)\/(reset|ban|unban|override)$/,
  );
  if (rlKeyActionMatch && method === "POST") {
    req.params = {
      ...req.params,
      name: rlKeyActionMatch[1],
      key: rlKeyActionMatch[2],
      keyAction: rlKeyActionMatch[3],
    };
    return handleAdminRateLimiters(req);
  }

  // DELETE /admin/ratelimiters/:name/keys/:key/override
  const rlKeyDeleteMatch = path.match(
    /^\/admin\/ratelimiters\/([^/]+)\/keys\/([^/]+)\/override$/,
  );
  if (rlKeyDeleteMatch && method === "DELETE") {
    req.params = { ...req.params, name: rlKeyDeleteMatch[1], key: rlKeyDeleteMatch[2] };
    return handleAdminRateLimiters(req);
  }

  // ── Webhook Routes (G12) ──────────────────────────────────────────────────

  // GET  /admin/webhooks — list all dispatchers
  if (method === "GET" && path === "/admin/webhooks") {
    req.params = { ...req.params };
    return handleAdminWebhooks(req);
  }

  // GET  /admin/webhooks/:name — dispatcher detail
  const whDetailMatch = path.match(/^\/admin\/webhooks\/([^/]+)$/);
  if (whDetailMatch && method === "GET") {
    req.params = { ...req.params, name: whDetailMatch[1] };
    return handleAdminWebhooks(req);
  }

  // GET  /admin/webhooks/:name/deliveries — delivery history
  const whDeliveriesMatch = path.match(/^\/admin\/webhooks\/([^/]+)\/deliveries$/);
  if (whDeliveriesMatch && method === "GET") {
    req.params = { ...req.params, name: whDeliveriesMatch[1], subResource: "deliveries" };
    return handleAdminWebhooks(req);
  }

  // POST /admin/webhooks/:name/(pause|resume) — dispatcher control
  const whActionMatch = path.match(/^\/admin\/webhooks\/([^/]+)\/(pause|resume)$/);
  if (whActionMatch && method === "POST") {
    req.params = { ...req.params, name: whActionMatch[1], action: whActionMatch[2] };
    return handleAdminWebhooks(req);
  }

  // POST /admin/webhooks/jobs/:id/resend — resend a failed job
  const whResendMatch = path.match(/^\/admin\/webhooks\/jobs\/([^/]+)\/resend$/);
  if (whResendMatch && method === "POST") {
    req.params = { ...req.params, jobId: whResendMatch[1] };
    return handleAdminWebhooks(req);
  }

  return { status: 404, body: { ok: false, error: "Not found" } };
}
