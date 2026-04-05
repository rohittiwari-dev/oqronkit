import { describe, it, expect } from "vitest";
import { OqronConfigSchema } from "../../src/engine/config/schema.js";
import { reconfigureConfig } from "../../src/engine/config/default-config.js";
import { cronModule, queueModule, scheduleModule } from "../../src/modules.js";

describe("OqronConfigSchema — Zod Validation", () => {
  it("applies all defaults for minimal config", () => {
    const result = OqronConfigSchema.parse({});
    expect(result.project).toBeUndefined();
    expect(result.environment).toBe("development");
    expect(result.mode).toBe("default");
    expect(result.modules).toEqual([]);
    expect(result.shutdown.enabled).toBe(true);
  });

  it("preserves overridden values", () => {
    const result = OqronConfigSchema.parse({
      project: "my-app",
      environment: "production",
    });
    expect(result.project).toBe("my-app");
    expect(result.environment).toBe("production");
  });

  it("validates mode enum", () => {
    const result = OqronConfigSchema.parse({ mode: "hybrid-db" });
    expect(result.mode).toBe("hybrid-db");
  });

  it("validates logger can be false", () => {
    const result = OqronConfigSchema.parse({ logger: false });
    expect(result.logger).toBe(false);
  });

  it("validates logger object", () => {
    const result = OqronConfigSchema.parse({
      logger: { level: "debug", prettify: true },
    });
    expect(result.logger).toEqual(
      expect.objectContaining({ level: "debug", prettify: true }),
    );
  });

  it("validates telemetry configuration", () => {
    const result = OqronConfigSchema.parse({
      telemetry: {
        prometheus: { enabled: true, path: "/custom-metrics" },
      },
    });
    expect(result.telemetry.prometheus.enabled).toBe(true);
    expect(result.telemetry.prometheus.path).toBe("/custom-metrics");
  });

  it("validates observability configuration", () => {
    const result = OqronConfigSchema.parse({
      observability: { maxJobLogs: 500, trackMemory: false },
    });
    expect(result.observability.maxJobLogs).toBe(500);
    expect(result.observability.trackMemory).toBe(false);
    expect(result.observability.maxTimelineEntries).toBe(20); // default
  });

  it("validates ui configuration", () => {
    const result = OqronConfigSchema.parse({
      ui: {
        enabled: true,
        auth: { username: "admin", password: "secret" },
      },
    });
    expect(result.ui.enabled).toBe(true);
    expect(result.ui.auth?.username).toBe("admin");
  });

  it("validates postgres configuration", () => {
    const result = OqronConfigSchema.parse({
      postgres: {
        connectionString: "postgresql://localhost:5432/oqron",
        tablePrefix: "app",
        poolSize: 20,
      },
    });
    expect(result.postgres?.connectionString).toBe(
      "postgresql://localhost:5432/oqron",
    );
    expect(result.postgres?.tablePrefix).toBe("app");
    expect(result.postgres?.poolSize).toBe(20);
  });

  it("postgres defaults tablePrefix and poolSize", () => {
    const result = OqronConfigSchema.parse({
      postgres: { connectionString: "postgresql://localhost/db" },
    });
    expect(result.postgres?.tablePrefix).toBe("oqron");
    expect(result.postgres?.poolSize).toBe(10);
  });

  it("postgres is optional", () => {
    const result = OqronConfigSchema.parse({});
    expect(result.postgres).toBeUndefined();
  });

  it("validates shutdown signals array", () => {
    const result = OqronConfigSchema.parse({
      shutdown: { signals: ["SIGUSR1", "SIGINT"] },
    });
    expect(result.shutdown.signals).toEqual(["SIGUSR1", "SIGINT"]);
  });
});

describe("reconfigureConfig — Module Normalization & Deep Merge", () => {
  it("merges user config with defaults", () => {
    const result = reconfigureConfig({ project: "custom-name" });
    expect(result.project).toBe("custom-name");
    expect(result.environment).toBe("development"); // default preserved
  });

  it("normalizes string shorthand modules", () => {
    const result = reconfigureConfig({
      modules: ["cron", "queue"],
    });
    expect(result.modules).toHaveLength(2);
    expect(result.modules[0].module).toBe("cron");
    expect(result.modules[1].module).toBe("queue");
  });

  it("normalizes factory-invoked modules", () => {
    const result = reconfigureConfig({
      modules: [cronModule({ tickInterval: 500 }), queueModule({ concurrency: 20 })],
    });
    expect(result.modules).toHaveLength(2);
    expect(result.modules[0].module).toBe("cron");
    expect((result.modules[0] as any).tickInterval).toBe(500);
    expect(result.modules[1].module).toBe("queue");
    expect((result.modules[1] as any).concurrency).toBe(20);
  });

  it("normalizes factory references (no invocation)", () => {
    const result = reconfigureConfig({
      modules: [cronModule],
    });
    expect(result.modules).toHaveLength(1);
    expect(result.modules[0].module).toBe("cron");
  });

  it("normalizes inline object modules", () => {
    const result = reconfigureConfig({
      modules: [{ module: "cron", tickInterval: 2000 }],
    });
    expect(result.modules).toHaveLength(1);
    expect(result.modules[0].module).toBe("cron");
    expect((result.modules[0] as any).tickInterval).toBe(2000);
  });

  it("supports mixed module input forms", () => {
    const result = reconfigureConfig({
      modules: [
        "cron",
        { module: "queue", concurrency: 10 },
        scheduleModule({ tickInterval: 3000 }),
      ],
    });
    expect(result.modules).toHaveLength(3);
    expect(result.modules.map((m) => m.module)).toEqual([
      "cron",
      "queue",
      "scheduler",
    ]);
  });

  it("deduplicates modules — last one wins", () => {
    const result = reconfigureConfig({
      modules: [
        cronModule({ tickInterval: 500 }),
        cronModule({ tickInterval: 2000 }),
      ],
    });
    expect(result.modules).toHaveLength(1);
    expect((result.modules[0] as any).tickInterval).toBe(2000);
  });

  it("deep-merges cron lagMonitor with defaults", () => {
    const result = reconfigureConfig({
      modules: [cronModule({ lagMonitor: { maxLagMs: 10000 } })],
    });
    const cron = result.modules[0] as any;
    expect(cron.lagMonitor.maxLagMs).toBe(10000);
    expect(cron.lagMonitor.sampleIntervalMs).toBe(1000); // default preserved
  });

  it("deep-merges queue retries with defaults", () => {
    const result = reconfigureConfig({
      modules: [queueModule({ retries: { max: 10 } })],
    });
    const queue = result.modules[0] as any;
    expect(queue.retries.max).toBe(10);
    expect(queue.retries.strategy).toBe("exponential"); // default
    expect(queue.retries.baseDelay).toBe(2000); // default
  });

  it("handles logger: false", () => {
    const result = reconfigureConfig({ logger: false });
    expect(result.logger).toBe(false);
  });

  it("passes through redis config", () => {
    const result = reconfigureConfig({ redis: "redis://localhost" });
    expect(result.redis).toBe("redis://localhost");
  });

  it("passes through postgres config with defaults", () => {
    const result = reconfigureConfig({
      postgres: { connectionString: "pg://localhost/db" },
    });
    expect(result.postgres?.connectionString).toBe("pg://localhost/db");
    expect(result.postgres?.tablePrefix).toBe("oqron");
    expect(result.postgres?.poolSize).toBe(10);
  });

  it("applies queue strategy default fifo", () => {
    const result = reconfigureConfig({
      modules: [queueModule()],
    });
    const queue = result.modules[0] as any;
    expect(queue.strategy).toBe("fifo");
  });
});
