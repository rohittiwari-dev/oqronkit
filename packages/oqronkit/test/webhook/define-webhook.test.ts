import { describe, expect, it, vi, beforeEach } from "vitest";
import { webhook } from "../../src/webhook/define-webhook.js";
import { OqronContainer } from "../../src/engine/index.js";
import { clearWebhooks } from "../../src/webhook/registry.js";
import type {
  WebhookConfig,
  WebhookEndpoint,
  WebhookDeliveryPayload,
} from "../../src/webhook/types.js";

// ── Mock the DI container ────────────────────────────────────────────────────

function createMockContainer(overrides: Record<string, any> = {}) {
  return {
    storage: {
      get: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
      ...overrides.storage,
    },
    broker: {
      publish: vi.fn().mockResolvedValue(undefined),
      ...overrides.broker,
    },
    lock: {
      acquire: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(true),
      ...overrides.lock,
    },
    config: {
      environment: "test",
      project: "test-project",
      modules: [],
      ...overrides.config,
    },
  };
}

describe("Webhook Factory (define-webhook)", () => {
  let mockDi: ReturnType<typeof createMockContainer>;

  beforeEach(() => {
    vi.resetAllMocks();
    clearWebhooks();
    mockDi = createMockContainer();
    vi.spyOn(OqronContainer, "get").mockReturnValue(mockDi as any);
  });

  // ── fire() — basic matching ──────────────────────────────────────────────

  describe("fire()", () => {
    it("should create jobs for each matched endpoint and publish to broker", async () => {
      const endpoints: WebhookEndpoint[] = [
        { name: "ep1", url: "http://ep1.com", events: ["user.*"] },
        { name: "ep2", url: "http://ep2.com", events: ["org.*"] },
      ];
      const config: WebhookConfig = {
        name: "test-dispatcher",
        endpoints,
      };

      const dispatcher = webhook<any>(config);
      const jobs = await dispatcher.fire("user.created", { foo: "bar" });

      // Only ep1 matches "user.created"
      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBeDefined();
      expect(jobs[0].type).toBe("webhook");
      expect(jobs[0].queueName).toBe("test-dispatcher");
      expect(jobs[0].moduleName).toBe("test-dispatcher");
      expect(jobs[0].status).toBe("waiting");
      expect(jobs[0].data.endpointName).toBe("ep1");
      expect(jobs[0].data.event).toBe("user.created");
      expect(jobs[0].data.body).toEqual({ foo: "bar" });
      expect(jobs[0].data.method).toBe("POST");

      // Verify storage + broker calls
      expect(mockDi.storage.save).toHaveBeenCalledTimes(1);
      expect(mockDi.broker.publish).toHaveBeenCalledTimes(1);
      expect(mockDi.broker.publish).toHaveBeenCalledWith(
        "test-dispatcher",
        jobs[0].id,
        undefined, // no delay
        undefined, // no priority
      );
    });

    it("should fire to multiple matching endpoints", async () => {
      const config: WebhookConfig = {
        name: "multi-match",
        endpoints: [
          { name: "ep1", url: "http://ep1.com", events: ["order.*"] },
          { name: "ep2", url: "http://ep2.com", events: ["order.created"] },
          { name: "ep3", url: "http://ep3.com", events: ["user.*"] },
        ],
      };

      const dispatcher = webhook<any>(config);
      const jobs = await dispatcher.fire("order.created", { id: 1 });

      // ep1 and ep2 match, ep3 does not
      expect(jobs).toHaveLength(2);
      expect(jobs.map((j) => j.data.endpointName).sort()).toEqual([
        "ep1",
        "ep2",
      ]);
    });

    it("should return empty array when no endpoints match", async () => {
      const config: WebhookConfig = {
        name: "no-match",
        endpoints: [
          { name: "ep1", url: "http://ep1.com", events: ["org.*"] },
        ],
      };

      const dispatcher = webhook<any>(config);
      const jobs = await dispatcher.fire("user.created", { foo: "bar" });

      expect(jobs).toHaveLength(0);
      expect(mockDi.storage.save).not.toHaveBeenCalled();
      expect(mockDi.broker.publish).not.toHaveBeenCalled();
    });

    it("should skip disabled endpoints (code-level)", async () => {
      const config: WebhookConfig = {
        name: "disabled-ep",
        endpoints: [
          {
            name: "ep1",
            url: "http://ep1.com",
            events: ["user.*"],
            enabled: false,
          },
          { name: "ep2", url: "http://ep2.com", events: ["user.*"] },
        ],
      };

      const dispatcher = webhook<any>(config);
      const jobs = await dispatcher.fire("user.created", { id: 1 });

      expect(jobs).toHaveLength(1);
      expect(jobs[0].data.endpointName).toBe("ep2");
    });

    it("should skip endpoints disabled via DB state", async () => {
      mockDi.storage.list.mockResolvedValue([
        { name: "ep1", enabled: false, dispatcherName: "db-disabled" },
      ]);

      const config: WebhookConfig = {
        name: "db-disabled",
        endpoints: [
          { name: "ep1", url: "http://ep1.com", events: ["user.*"] },
          { name: "ep2", url: "http://ep2.com", events: ["user.*"] },
        ],
      };

      const dispatcher = webhook<any>(config);
      const jobs = await dispatcher.fire("user.created", { id: 1 });

      expect(jobs).toHaveLength(1);
      expect(jobs[0].data.endpointName).toBe("ep2");
    });
  });

  // ── fire() — dynamic endpoints/headers/URLs ─────────────────────────────

  describe("fire() — dynamic resolution", () => {
    it("should resolve dynamic URL functions", async () => {
      const config: WebhookConfig = {
        name: "dynamic-url",
        endpoints: [
          {
            name: "ep1",
            url: (data: any) => `http://ep1.com/${data.id}`,
            events: ["user.*"],
          },
        ],
      };

      const dispatcher = webhook<any>(config);
      const jobs = await dispatcher.fire("user.created", { id: 123 });

      expect(jobs[0].data.url).toBe("http://ep1.com/123");
    });

    it("should merge global and endpoint headers", async () => {
      const config: WebhookConfig = {
        name: "headers-merge",
        headers: { "x-global": "yes" },
        endpoints: [
          {
            name: "ep1",
            url: "http://ep1.com",
            events: ["user.*"],
            headers: { "x-local": "abc" },
          },
        ],
      };

      const dispatcher = webhook<any>(config);
      const jobs = await dispatcher.fire("user.created", { val: "test" });

      expect(jobs[0].data.headers).toEqual({
        "x-global": "yes",
        "x-local": "abc",
      });
    });

    it("should resolve dynamic header functions", async () => {
      const config: WebhookConfig = {
        name: "dynamic-headers",
        endpoints: [
          {
            name: "ep1",
            url: "http://ep1.com",
            events: ["user.*"],
            headers: (data: any) => ({ "x-tenant": data.tenantId }),
          },
        ],
      };

      const dispatcher = webhook<any>(config);
      const jobs = await dispatcher.fire("user.created", {
        tenantId: "acme",
      });

      expect(jobs[0].data.headers["x-tenant"]).toBe("acme");
    });

    it("should resolve async endpoint functions", async () => {
      const config: WebhookConfig = {
        name: "async-endpoints",
        endpoints: async () => [
          { name: "ep1", url: "http://ep1.com", events: ["user.*"] },
        ],
      };

      const dispatcher = webhook<any>(config);
      const jobs = await dispatcher.fire("user.created", { foo: "bar" });

      expect(jobs).toHaveLength(1);
      expect(jobs[0].data.endpointName).toBe("ep1");
    });

    it("should apply transform function to body", async () => {
      const config: WebhookConfig = {
        name: "transform",
        transform: (data: any, _ep) => ({
          wrapped: true,
          payload: data,
        }),
        endpoints: [
          { name: "ep1", url: "http://ep1.com", events: ["order.*"] },
        ],
      };

      const dispatcher = webhook<any>(config);
      const jobs = await dispatcher.fire("order.created", { id: 1 });

      expect(jobs[0].data.transformedBody).toEqual({
        wrapped: true,
        payload: { id: 1 },
      });
    });
  });

  // ── fire() — disabled instance behaviors ────────────────────────────────

  describe("fire() — disabled behaviors", () => {
    it("should hold jobs when instance is disabled with behavior=hold", async () => {
      mockDi.storage.get.mockImplementation(
        async (ns: string, key: string) => {
          if (ns === "webhook_instances" && key === "hold-dispatcher") {
            return { enabled: false };
          }
          return null;
        },
      );

      const config: WebhookConfig = {
        name: "hold-dispatcher",
        disabledBehavior: "hold",
        endpoints: [
          { name: "ep1", url: "http://ep1.com", events: ["user.*"] },
        ],
      };

      const dispatcher = webhook<any>(config);
      const jobs = await dispatcher.fire("user.created", { id: 1 });

      expect(jobs).toHaveLength(1);
      expect(jobs[0].status).toBe("paused");
      expect(jobs[0].pausedReason).toBe("disabled-hold");
      // Should save to storage but NOT publish to broker
      expect(mockDi.storage.save).toHaveBeenCalled();
      expect(mockDi.broker.publish).not.toHaveBeenCalled();
    });

    it("should throw when instance is disabled with behavior=reject", async () => {
      mockDi.storage.get.mockImplementation(
        async (ns: string, key: string) => {
          if (ns === "webhook_instances" && key === "reject-dispatcher") {
            return { enabled: false };
          }
          return null;
        },
      );

      const config: WebhookConfig = {
        name: "reject-dispatcher",
        disabledBehavior: "reject",
        endpoints: [
          { name: "ep1", url: "http://ep1.com", events: ["user.*"] },
        ],
      };

      const dispatcher = webhook<any>(config);
      await expect(
        dispatcher.fire("user.created", { id: 1 }),
      ).rejects.toThrow("disabled and configured to reject");
    });

    it("should silently skip when instance is disabled with behavior=skip", async () => {
      mockDi.storage.get.mockImplementation(
        async (ns: string, key: string) => {
          if (ns === "webhook_instances" && key === "skip-dispatcher") {
            return { enabled: false };
          }
          return null;
        },
      );

      const config: WebhookConfig = {
        name: "skip-dispatcher",
        disabledBehavior: "skip",
        endpoints: [
          { name: "ep1", url: "http://ep1.com", events: ["user.*"] },
        ],
      };

      const dispatcher = webhook<any>(config);
      const jobs = await dispatcher.fire("user.created", { id: 1 });

      // Skip returns a stub job with status=completed
      expect(jobs).toHaveLength(1);
      expect(jobs[0].status).toBe("completed");
      expect(mockDi.broker.publish).not.toHaveBeenCalled();
    });
  });

  // ── fireToEndpoint() ────────────────────────────────────────────────────

  describe("fireToEndpoint()", () => {
    it("should fire directly to a named endpoint", async () => {
      const config: WebhookConfig = {
        name: "direct-fire",
        endpoints: [
          { name: "ep1", url: "http://ep1.com", events: ["user.*"] },
          { name: "ep2", url: "http://ep2.com", events: ["org.*"] },
        ],
      };

      const dispatcher = webhook<any>(config);
      const job = await dispatcher.fireToEndpoint("ep2", { id: 1 });

      expect(job.data.endpointName).toBe("ep2");
      expect(job.data.event).toBe("direct");
      expect(job.data.url).toBe("http://ep2.com");
    });

    it("should throw if endpoint name not found", async () => {
      const config: WebhookConfig = {
        name: "missing-ep",
        endpoints: [
          { name: "ep1", url: "http://ep1.com", events: ["user.*"] },
        ],
      };

      const dispatcher = webhook<any>(config);
      await expect(
        dispatcher.fireToEndpoint("nonexistent", { id: 1 }),
      ).rejects.toThrow("not found");
    });

    it("should throw if targeted endpoint is disabled", async () => {
      mockDi.storage.get.mockImplementation(
        async (ns: string, _key: string) => {
          if (ns === "webhook_endpoints") {
            return { enabled: false };
          }
          return null;
        },
      );

      const config: WebhookConfig = {
        name: "disabled-direct",
        endpoints: [
          { name: "ep1", url: "http://ep1.com", events: ["user.*"] },
        ],
      };

      const dispatcher = webhook<any>(config);
      await expect(
        dispatcher.fireToEndpoint("ep1", { id: 1 }),
      ).rejects.toThrow("currently disabled");
    });
  });

  // ── Endpoint Management ─────────────────────────────────────────────────

  describe("Endpoint Management", () => {
    it("should add an endpoint via addEndpoint()", async () => {
      const config: WebhookConfig = {
        name: "ep-mgmt",
        endpoints: [],
      };
      const dispatcher = webhook<any>(config);

      await dispatcher.addEndpoint({
        name: "new-ep",
        url: "http://new.com",
        events: ["user.*"],
      });

      expect(mockDi.storage.save).toHaveBeenCalledWith(
        "webhook_endpoints",
        "ep-mgmt:new-ep",
        expect.objectContaining({
          dispatcherName: "ep-mgmt",
          name: "new-ep",
          enabled: true,
        }),
      );
    });

    it("should remove an endpoint via removeEndpoint()", async () => {
      mockDi.storage.get.mockImplementation(
        async (ns: string, _key: string) => {
          if (ns === "webhook_endpoints") return { name: "ep1" };
          return null;
        },
      );

      const config: WebhookConfig = {
        name: "ep-remove",
        endpoints: [],
      };
      const dispatcher = webhook<any>(config);
      const removed = await dispatcher.removeEndpoint("ep1");

      expect(removed).toBe(true);
      expect(mockDi.storage.delete).toHaveBeenCalledWith(
        "webhook_endpoints",
        "ep-remove:ep1",
      );
    });

    it("should return false when removing non-existent endpoint", async () => {
      const config: WebhookConfig = {
        name: "ep-remove-miss",
        endpoints: [],
      };
      const dispatcher = webhook<any>(config);
      const removed = await dispatcher.removeEndpoint("ghost");

      expect(removed).toBe(false);
    });

    it("should enable an endpoint via enableEndpoint()", async () => {
      const config: WebhookConfig = {
        name: "ep-enable",
        endpoints: [],
      };
      const dispatcher = webhook<any>(config);
      await dispatcher.enableEndpoint("ep1");

      expect(mockDi.storage.save).toHaveBeenCalledWith(
        "webhook_endpoints",
        "ep-enable:ep1",
        expect.objectContaining({ enabled: true }),
      );
    });

    it("should disable an endpoint via disableEndpoint()", async () => {
      const config: WebhookConfig = {
        name: "ep-disable",
        endpoints: [],
      };
      const dispatcher = webhook<any>(config);
      await dispatcher.disableEndpoint("ep1");

      expect(mockDi.storage.save).toHaveBeenCalledWith(
        "webhook_endpoints",
        "ep-disable:ep1",
        expect.objectContaining({ enabled: false }),
      );
    });
  });

  // ── Job Options ────────────────────────────────────────────────────────

  describe("Job options", () => {
    it("should support delayed delivery", async () => {
      const config: WebhookConfig = {
        name: "delayed",
        endpoints: [
          { name: "ep1", url: "http://ep1.com", events: ["order.*"] },
        ],
      };

      const dispatcher = webhook<any>(config);
      const jobs = await dispatcher.fire("order.created", { id: 1 }, {
        delay: 30000,
      });

      expect(jobs[0].status).toBe("delayed");
      expect(jobs[0].runAt).toBeDefined();
      expect(mockDi.broker.publish).toHaveBeenCalledWith(
        "delayed",
        jobs[0].id,
        30000,
        undefined,
      );
    });

    it("should support priority", async () => {
      const config: WebhookConfig = {
        name: "priority",
        endpoints: [
          { name: "ep1", url: "http://ep1.com", events: ["order.*"] },
        ],
      };

      const dispatcher = webhook<any>(config);
      const jobs = await dispatcher.fire("order.created", { id: 1 }, {
        priority: 10,
      });

      expect(mockDi.broker.publish).toHaveBeenCalledWith(
        "priority",
        jobs[0].id,
        undefined,
        10,
      );
    });
  });
});
