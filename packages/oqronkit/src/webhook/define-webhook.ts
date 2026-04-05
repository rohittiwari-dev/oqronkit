import { randomUUID } from "node:crypto";
import { OqronContainer } from "../engine/index.js";
import type {
  OqronJob,
  OqronJobOptions,
  PausedReason,
} from "../engine/types/job.types.js";
import { DependencyResolver } from "../engine/utils/dependency-resolver.js";
import { matchesEvent } from "./event-matcher.js";
import { registerWebhook } from "./registry.js";
import type {
  IWebhookDispatcher,
  WebhookConfig,
  WebhookDeliveryPayload,
  WebhookEndpoint,
  WebhookSecurity,
} from "./types.js";

async function resolveEndpoints(
  input: WebhookConfig["endpoints"],
): Promise<WebhookEndpoint[]> {
  if (Array.isArray(input)) return input;
  return await input();
}

async function resolveSecurity(
  input?: WebhookConfig["security"],
): Promise<WebhookSecurity | undefined> {
  if (!input) return undefined;
  if (typeof input === "function") return await input();
  return input;
}

export function webhook<T = any>(
  config: WebhookConfig<T>,
): IWebhookDispatcher<T> {
  registerWebhook(config as any);

  async function resolveJobPayload(
    event: string,
    data: T,
    endpoint: WebhookEndpoint,
    id: string,
  ): Promise<WebhookDeliveryPayload<T>> {
    const url =
      typeof endpoint.url === "function"
        ? await endpoint.url(data)
        : endpoint.url;
    const headersBase = config.headers || {};
    const headersEp =
      typeof endpoint.headers === "function"
        ? await endpoint.headers(data)
        : endpoint.headers || {};

    const transformedBody = config.transform
      ? await config.transform(data, endpoint)
      : undefined;

    const security = await resolveSecurity(
      endpoint.security || config.security,
    );

    return {
      event,
      endpointName: endpoint.name,
      dispatcherName: config.name,
      url,
      method: endpoint.method || config.method || "POST",
      headers: { ...headersBase, ...headersEp },
      body: data,
      transformedBody,
      security,
      idempotencyKey: `${config.name}:${endpoint.name}:${id}`,
      timestamp: Date.now(),
    };
  }

  async function enqueue(
    payload: WebhookDeliveryPayload<T>,
    opts?: OqronJobOptions,
  ): Promise<OqronJob<WebhookDeliveryPayload<T>>> {
    const di = OqronContainer.get();
    const jobId = opts?.jobId ?? randomUUID();
    const hasDeps = opts?.dependsOn && opts.dependsOn.length > 0;

    const instanceState = await di.storage.get<{ enabled: boolean }>(
      "webhook_instances",
      config.name,
    );
    const isInstanceEnabled = instanceState ? instanceState.enabled : true;

    // Resolve disabledBehavior: per-dispatcher → module-level → "hold" default
    const moduleConfig =
      (di.config?.modules?.find?.((m: any) => m.module === "webhook") as any) ??
      {};
    const behavior =
      config.disabledBehavior ?? moduleConfig.disabledBehavior ?? "hold";

    if (!isInstanceEnabled && behavior === "reject") {
      throw new Error(
        `Webhook dispatcher ${config.name} is disabled and configured to reject new jobs`,
      );
    }

    if (!isInstanceEnabled && behavior === "skip") {
      // Silently drop
      return { id: jobId, status: "completed" } as any;
    }

    // Determine initial status based on opts and enabled state
    let initialStatus: OqronJob["status"] = "waiting";
    let pausedReason: PausedReason | undefined;

    if (!isInstanceEnabled && behavior === "hold") {
      initialStatus = "paused";
      pausedReason = "disabled-hold";
    } else if (hasDeps) {
      initialStatus = "waiting-children";
    } else if (opts?.delay) {
      initialStatus = "delayed";
    }

    const job: OqronJob<WebhookDeliveryPayload<T>> = {
      id: jobId,
      type: "webhook",
      queueName: config.name, // The dispatcher name routes the job
      moduleName: config.name,
      status: initialStatus,
      pausedReason,
      data: payload,
      opts: opts ?? {},
      attemptMade: 0,
      progressPercent: 0,
      tags: [],
      environment: di.config?.environment ?? "default",
      project: di.config?.project ?? "default",
      createdAt: new Date(),
      queuedAt: new Date(),
      triggeredBy: "api",
      correlationId: opts?.correlationId,
      maxAttempts: opts?.attempts ?? 1, // webhook-engine will handle retries too
      logs: [],
      timeline: [],
      steps: [],
      runAt: opts?.delay ? new Date(Date.now() + opts.delay) : undefined,
    };

    // 1. Storage
    await di.storage.save("jobs", jobId, job);

    // Handle pruning for held jobs
    if (!isInstanceEnabled && behavior === "hold") {
      const maxHeld = moduleConfig.maxHeldJobs ?? 100;
      const heldJobs = await di.storage.list<any>(
        "jobs",
        {
          moduleName: "webhook",
          queueName: config.name,
          status: "paused",
          pausedReason: "disabled-hold",
        },
        { limit: 100_000 },
      );

      heldJobs.sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );

      if (heldJobs.length > maxHeld) {
        const toRemove = heldJobs.slice(0, heldJobs.length - maxHeld);
        for (const old of toRemove) {
          await di.storage.delete("jobs", old.id);
        }
      }
    }

    // 2. Register dependencies
    if (hasDeps) {
      await DependencyResolver.registerDependencies(
        di.storage,
        jobId,
        opts!.dependsOn!,
        di.lock,
      );
    } else if (job.status !== "paused") {
      // 3. Transport
      await di.broker.publish(
        config.name, // Route to the dispatcher group
        jobId,
        opts?.delay,
        opts?.priority,
      );
    }

    return job;
  }

  const dispatcher: IWebhookDispatcher<T> = {
    name: config.name,

    async fire(event, data, opts) {
      const di = OqronContainer.get();
      const endpoints = await resolveEndpoints(config.endpoints);

      // Check for DB-level endpoint overrides (e.g. disabled via API)
      const dbEndpoints =
        (await di.storage.list<{
          name: string;
          enabled: boolean;
        }>(
          "webhook_endpoints",
          { dispatcherName: config.name },
          { limit: 1000 },
        )) || [];
      const dbEndpointMap = new Map(dbEndpoints.map((ep) => [ep.name, ep]));

      const matchingEndpoints = endpoints.filter((ep) => {
        // Priority: DB State > Code State > true
        const dbState = dbEndpointMap.get(ep.name);
        const resolvedEnabled = dbState
          ? dbState.enabled
          : ep.enabled !== false;

        if (!resolvedEnabled) return false;

        return matchesEvent(event, ep.events);
      });

      const promises = matchingEndpoints.map(async (ep) => {
        const uuid = randomUUID();
        const payload = await resolveJobPayload(event, data, ep, uuid);
        return enqueue(payload, { ...opts, jobId: uuid });
      });

      return Promise.all(promises);
    },

    async fireToEndpoint(endpointName, data, opts) {
      const endpoints = await resolveEndpoints(config.endpoints);
      const ep = endpoints.find((e) => e.name === endpointName);
      if (!ep) {
        throw new Error(
          `Webhook endpoint '${endpointName}' not found in dispatcher '${config.name}'`,
        );
      }

      const di = OqronContainer.get();
      const dbState = await di.storage.get<{ enabled: boolean }>(
        "webhook_endpoints",
        `${config.name}:${endpointName}`,
      );
      const isEnabled = dbState ? dbState.enabled : ep.enabled !== false;

      if (!isEnabled) {
        throw new Error(
          `Webhook endpoint '${endpointName}' on dispatcher '${config.name}' is currently disabled`,
        );
      }

      const uuid = randomUUID();
      const payload = await resolveJobPayload("direct", data, ep, uuid);
      return enqueue(payload, { ...opts, jobId: uuid });
    },

    async getEndpoints() {
      const endpoints = await resolveEndpoints(config.endpoints);
      const di = OqronContainer.get();
      const dbEndpoints =
        (await di.storage.list<{
          name: string;
          enabled: boolean;
        }>(
          "webhook_endpoints",
          { dispatcherName: config.name },
          { limit: 1000 },
        )) || [];
      const dbMap = new Map(dbEndpoints.map((ep) => [ep.name, ep]));

      return endpoints.map((ep) => {
        const dbState = dbMap.get(ep.name);
        return {
          ...ep,
          enabled: dbState ? dbState.enabled : ep.enabled !== false,
        };
      });
    },

    async getEndpoint(name) {
      const endpoints = await this.getEndpoints();
      return endpoints.find((ep) => ep.name === name);
    },

    async addEndpoint(endpoint) {
      const di = OqronContainer.get();
      // Technically, if endpoints is a static array, this won't persist into the array unless
      // the array is dynamic (which is the point of the feature, to use dynamic functions).
      // However, we save it into the webhook_endpoints DB table so `getEndpoints` could merge it
      // or dynamic functions can query it.
      await di.storage.save(
        "webhook_endpoints",
        `${config.name}:${endpoint.name}`,
        {
          dispatcherName: config.name,
          ...endpoint,
          enabled: endpoint.enabled !== false,
        },
      );
    },

    async removeEndpoint(name) {
      const di = OqronContainer.get();
      const existed = await di.storage.get(
        "webhook_endpoints",
        `${config.name}:${name}`,
      );
      if (existed) {
        await di.storage.delete("webhook_endpoints", `${config.name}:${name}`);
        return true;
      }
      return false;
    },

    async enableEndpoint(name) {
      const di = OqronContainer.get();
      await di.storage.save("webhook_endpoints", `${config.name}:${name}`, {
        dispatcherName: config.name,
        name,
        enabled: true,
      });
      return true;
    },

    async disableEndpoint(name) {
      const di = OqronContainer.get();
      await di.storage.save("webhook_endpoints", `${config.name}:${name}`, {
        dispatcherName: config.name,
        name,
        enabled: false,
      });
      return true;
    },
  };

  return dispatcher;
}
