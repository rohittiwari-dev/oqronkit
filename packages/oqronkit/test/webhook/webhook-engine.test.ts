import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { WebhookEngine } from "../../src/webhook/webhook-engine.js";
import type { OqronJob } from "../../src/engine/types/job.types.js";
import type { WebhookDeliveryPayload } from "../../src/webhook/types.js";
import * as delivery from "../../src/webhook/delivery.js";
import * as hmac from "../../src/webhook/hmac.js";
import { OqronContainer } from "../../src/engine/index.js";

// ── Canonical OqronJob mock factory ─────────────────────────────────────────

function createMockJob(
  overrides: Partial<OqronJob<WebhookDeliveryPayload>> = {},
): OqronJob<WebhookDeliveryPayload> {
  return {
    id: "job-1",
    type: "webhook",
    queueName: "test-dispatcher",
    moduleName: "test-dispatcher",
    status: "waiting",
    data: {
      event: "test.event",
      endpointName: "ep1",
      dispatcherName: "test-dispatcher",
      url: "http://example.com/webhook",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { hello: "world" },
      idempotencyKey: "test-dispatcher:ep1:job-1",
      timestamp: Date.now(),
    },
    opts: {},
    attemptMade: 0,
    progressPercent: 0,
    tags: [],
    environment: "test",
    project: "default",
    createdAt: new Date(),
    logs: [],
    timeline: [],
    steps: [],
    ...overrides,
  } as any;
}

// ── Mock container factory ──────────────────────────────────────────────────

function createMockDi() {
  return {
    storage: {
      get: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    broker: {
      claim: vi.fn().mockResolvedValue([]),
      ack: vi.fn().mockResolvedValue(undefined),
      nack: vi.fn().mockResolvedValue(undefined),
      publish: vi.fn().mockResolvedValue(undefined),
    },
    lock: {
      acquire: vi.fn().mockResolvedValue(true),
      renew: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(true),
      isOwner: vi.fn().mockResolvedValue(true),
    },
    config: {
      environment: "test",
      project: "default",
    },
  };
}

describe("WebhookEngine", () => {
  let mockDi: ReturnType<typeof createMockDi>;
  let mockLogger: any;
  let mockConfig: any;

  beforeEach(() => {
    vi.resetAllMocks();
    mockDi = createMockDi();
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    mockConfig = {
      environment: "test",
      project: "default",
    };

    vi.spyOn(delivery, "deliverWebhook").mockResolvedValue({
      status: 200,
      headers: {},
      body: "OK",
      durationMs: 50,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createEngine(webhookConf: any = {}) {
    const engine = new WebhookEngine(
      mockConfig,
      mockLogger,
      { module: "webhook" as const, ...webhookConf },
      mockDi as any,
    );
    engine["running"] = true;
    engine["enabled"] = true;
    return engine;
  }

  // ── processJob: Success ─────────────────────────────────────────────────

  it("should process a job successfully — deliver, ack, emit success", async () => {
    const job = createMockJob();
    mockDi.storage.get.mockResolvedValueOnce(job);

    const config = {
      name: "test-dispatcher",
      endpoints: [
        { name: "ep1", url: "http://example.com/webhook", events: ["*"] },
      ],
    };

    const engine = createEngine();
    await engine["processJob"](config as any, "job-1");

    // Delivery called
    expect(delivery.deliverWebhook).toHaveBeenCalledTimes(1);
    expect(delivery.deliverWebhook).toHaveBeenCalledWith(
      "http://example.com/webhook",
      "POST",
      expect.objectContaining({ "content-type": "application/json" }),
      expect.any(String),
      30000,
    );

    // Job marked completed in storage
    expect(mockDi.storage.save).toHaveBeenCalled();
    const savedJob = mockDi.storage.save.mock.calls.find(
      (c: any[]) => c[0] === "jobs" && c[2]?.status === "completed",
    );
    expect(savedJob).toBeDefined();
    expect(savedJob![2].status).toBe("completed");
    expect(savedJob![2].progressPercent).toBe(100);

    // Ack — removes from broker queue
    expect(mockDi.broker.ack).toHaveBeenCalledWith("test-dispatcher", "job-1");

    // NO broker.fail call (it doesn't exist on IBrokerEngine)
    expect((mockDi.broker as any).fail).toBeUndefined();
  });

  // ── processJob: onSuccess hook ────────────────────────────────────────

  it("should fire onSuccess hook (fire-and-forget) on success", async () => {
    const onSuccessHook = vi.fn();
    const job = createMockJob();
    mockDi.storage.get.mockResolvedValueOnce(job);

    const config = {
      name: "test-dispatcher",
      endpoints: [],
      hooks: { onSuccess: onSuccessHook },
    };

    const engine = createEngine();
    await engine["processJob"](config as any, "job-1");

    // Hooks fire asynchronously — give microtasks a chance
    await new Promise((r) => setTimeout(r, 10));

    expect(onSuccessHook).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job-1", status: "completed" }),
      expect.objectContaining({ status: 200 }),
    );
  });

  // ── processJob: Non-retryable failure → handleHardFail → broker.ack ─────

  it("should handle non-retryable HTTP error — hard fail, ack (NOT fail)", async () => {
    const onFailHook = vi.fn();
    const job = createMockJob();
    mockDi.storage.get.mockResolvedValueOnce(job);

    vi.spyOn(delivery, "deliverWebhook").mockResolvedValue({
      status: 400,
      headers: {},
      body: "Bad Request",
      durationMs: 20,
    });
    vi.spyOn(delivery, "shouldRetryDelivery").mockReturnValue(false);

    const config = {
      name: "test-dispatcher",
      endpoints: [],
      retries: { max: 3 },
      hooks: { onFail: onFailHook },
    };

    const engine = createEngine();
    await engine["processJob"](config as any, "job-1");

    // Job marked as "failed"
    const savedJob = mockDi.storage.save.mock.calls.find(
      (c: any[]) => c[0] === "jobs" && c[2]?.status === "failed",
    );
    expect(savedJob).toBeDefined();
    expect(savedJob![2].error).toContain("Unretryable HTTP 400");

    // broker.ack — NOT broker.fail (broker.fail doesn't exist)
    expect(mockDi.broker.ack).toHaveBeenCalledWith("test-dispatcher", "job-1");

    // onFail fires async
    await new Promise((r) => setTimeout(r, 10));
    expect(onFailHook).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job-1" }),
      expect.any(Error),
    );
  });

  // ── processJob: Retryable error → handleRetry → broker.nack (3 args) ──

  it("should retry on network error — nack with 3 args (name, id, backoffMs)", async () => {
    const job = createMockJob({ attemptMade: 0 });
    mockDi.storage.get.mockResolvedValueOnce(job);

    vi.spyOn(delivery, "deliverWebhook").mockRejectedValue(
      new Error("ECONNREFUSED"),
    );

    const config = {
      name: "test-dispatcher",
      endpoints: [],
      retries: { max: 3, strategy: "fixed", baseDelay: 5000 },
    };

    const engine = createEngine();
    await engine["processJob"](config as any, "job-1");

    // Job marked as "delayed" for retry
    const savedJob = mockDi.storage.save.mock.calls.find(
      (c: any[]) => c[0] === "jobs" && c[2]?.status === "delayed",
    );
    expect(savedJob).toBeDefined();
    expect(savedJob![2].attemptMade).toBe(1);

    // broker.nack with EXACTLY 3 args: (name, id, backoffMs)
    expect(mockDi.broker.nack).toHaveBeenCalledTimes(1);
    expect(mockDi.broker.nack).toHaveBeenCalledWith(
      "test-dispatcher",
      "job-1",
      expect.any(Number),
    );
    // Verify it's 3 args, not 4
    expect(mockDi.broker.nack.mock.calls[0]).toHaveLength(3);
  });

  // ── processJob: Max retries exhausted → hard fail ─────────────────────

  it("should hard-fail when attempts >= max retries", async () => {
    const job = createMockJob({ attemptMade: 3 }); // will become 4 after increment
    mockDi.storage.get.mockResolvedValueOnce(job);

    vi.spyOn(delivery, "deliverWebhook").mockRejectedValue(
      new Error("timeout"),
    );

    const config = {
      name: "test-dispatcher",
      endpoints: [],
      retries: { max: 3 },
    };

    const engine = createEngine();
    await engine["processJob"](config as any, "job-1");

    // Hard fail — status "failed", broker.ack
    const savedJob = mockDi.storage.save.mock.calls.find(
      (c: any[]) => c[0] === "jobs" && c[2]?.status === "failed",
    );
    expect(savedJob).toBeDefined();
    expect(mockDi.broker.ack).toHaveBeenCalledWith("test-dispatcher", "job-1");
  });

  // ── processJob: Missing job → ack (phantom cleanup) ──────────────────

  it("should ack and return if job is not found in storage", async () => {
    mockDi.storage.get.mockResolvedValueOnce(null);

    const config = { name: "test-dispatcher", endpoints: [] };
    const engine = createEngine();
    await engine["processJob"](config as any, "phantom-job");

    expect(mockDi.broker.ack).toHaveBeenCalledWith(
      "test-dispatcher",
      "phantom-job",
    );
    expect(delivery.deliverWebhook).not.toHaveBeenCalled();
  });

  // ── processJob: Paused job → ack (skip processing) ──────────────────

  it("should ack and skip processing for paused jobs", async () => {
    const job = createMockJob({ status: "paused" });
    mockDi.storage.get.mockResolvedValueOnce(job);

    const config = { name: "test-dispatcher", endpoints: [] };
    const engine = createEngine();
    await engine["processJob"](config as any, "job-1");

    expect(mockDi.broker.ack).toHaveBeenCalledWith("test-dispatcher", "job-1");
    expect(delivery.deliverWebhook).not.toHaveBeenCalled();
  });

  // ── processJob: Completed job → ack (skip processing) ────────────────

  it("should ack and skip processing for already-completed jobs", async () => {
    const job = createMockJob({ status: "completed" });
    mockDi.storage.get.mockResolvedValueOnce(job);

    const config = { name: "test-dispatcher", endpoints: [] };
    const engine = createEngine();
    await engine["processJob"](config as any, "job-1");

    expect(mockDi.broker.ack).toHaveBeenCalledWith("test-dispatcher", "job-1");
    expect(delivery.deliverWebhook).not.toHaveBeenCalled();
  });

  // ── processJob: Wrong environment → nack (return to pool) ────────────

  it("should nack job back to broker if environment doesn't match", async () => {
    const job = createMockJob({ environment: "production" });
    mockDi.storage.get.mockResolvedValueOnce(job);

    const config = { name: "test-dispatcher", endpoints: [] };
    const engine = createEngine();
    // engine is in "test" env, job is in "production"
    await engine["processJob"](config as any, "job-1");

    expect(mockDi.broker.nack).toHaveBeenCalledWith(
      "test-dispatcher",
      "job-1",
    );
    expect(delivery.deliverWebhook).not.toHaveBeenCalled();
  });

  // ── processJob: HMAC signing ─────────────────────────────────────────

  it("should sign payload when security is configured", async () => {
    const signSpy = vi
      .spyOn(hmac, "signWebhookPayload")
      .mockResolvedValue("t=123,v1=abc123");

    const job = createMockJob({
      data: {
        ...createMockJob().data,
        security: {
          signingSecret: "my-secret",
          signingAlgorithm: "sha256",
          signingHeader: "X-Sig",
          timestampHeader: "X-TS",
          includeTimestamp: true,
        },
      },
    });
    mockDi.storage.get.mockResolvedValueOnce(job);

    const config = { name: "test-dispatcher", endpoints: [] };
    const engine = createEngine();
    await engine["processJob"](config as any, "job-1");

    expect(signSpy).toHaveBeenCalledWith(
      expect.any(String), // body string
      "my-secret",
      expect.any(Number), // timestamp
      "sha256",
      undefined, // no custom sign fn
    );

    // Verify signature header was injected
    expect(delivery.deliverWebhook).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ "X-Sig": "t=123,v1=abc123" }),
      expect.any(String),
      expect.any(Number),
    );
  });

  // ── processJob: DLQ ──────────────────────────────────────────────────

  it("should invoke deadLetter.onDead when all retries exhausted", async () => {
    const onDead = vi.fn();
    const job = createMockJob({ attemptMade: 3 });
    mockDi.storage.get.mockResolvedValueOnce(job);

    vi.spyOn(delivery, "deliverWebhook").mockRejectedValue(
      new Error("dead"),
    );

    const config = {
      name: "test-dispatcher",
      endpoints: [],
      retries: { max: 3 },
      deadLetter: { enabled: true, onDead },
    };

    const engine = createEngine();
    await engine["processJob"](config as any, "job-1");

    expect(onDead).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job-1", status: "failed" }),
    );
  });

  // ── processJob: Lock not acquired → nack ─────────────────────────────

  it("should nack if lock cannot be acquired", async () => {
    mockDi.lock.acquire.mockResolvedValueOnce(false);

    const config = { name: "test-dispatcher", endpoints: [] };
    const engine = createEngine();
    await engine["processJob"](config as any, "job-1");

    expect(mockDi.broker.nack).toHaveBeenCalledWith(
      "test-dispatcher",
      "job-1",
      1000,
    );
    expect(delivery.deliverWebhook).not.toHaveBeenCalled();
  });

  // ── processJob: attemptMade null guard ────────────────────────────────

  it("should handle null attemptMade gracefully", async () => {
    const job = createMockJob({ attemptMade: undefined as any });
    mockDi.storage.get.mockResolvedValueOnce(job);

    const config = { name: "test-dispatcher", endpoints: [] };
    const engine = createEngine();
    await engine["processJob"](config as any, "job-1");

    // Should not throw — null guard converts undefined to 0 + 1 = 1
    const savedJob = mockDi.storage.save.mock.calls.find(
      (c: any[]) => c[0] === "jobs",
    );
    expect(savedJob).toBeDefined();
    expect(savedJob![2].attemptMade).toBe(1);
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────

  it("should report name as 'webhook'", () => {
    const engine = createEngine();
    expect(engine.name).toBe("webhook");
  });

  it("should be enabled by default", () => {
    const engine = new WebhookEngine(
      mockConfig,
      mockLogger,
      { module: "webhook" as const },
      mockDi as any,
    );
    expect(engine.enabled).toBe(true);
  });
});
