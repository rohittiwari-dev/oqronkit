import { describe, it, expect, beforeEach } from "vitest";
import { OqronConfigSchema } from "../../src/engine/config/schema.js";
import { reconfigureConfig } from "../../src/engine/config/default-config.js";
import type { OqronConfig } from "../../src/engine/types/config.types.js";

describe("OqronConfigSchema — Zod Validation", () => {
  it("applies all defaults for minimal config", () => {
    const result = OqronConfigSchema.parse({});
    // project is optional at schema level — default comes from reconfigureConfig()
    expect(result.project).toBeUndefined();
    expect(result.environment).toBe("development");
    expect(result.modules).toEqual([]);
    expect(result.cron.enable).toBe(true);
    expect(result.cron.timezone).toBe("UTC");
    expect(result.taskQueue.concurrency).toBe(5);
    expect(result.worker.concurrency).toBe(5);
    expect(result.shutdown.enabled).toBe(true);
  });

  it("preserves overridden values", () => {
    const result = OqronConfigSchema.parse({
      project: "my-app",
      environment: "production",
      taskQueue: { concurrency: 20 },
    });
    expect(result.project).toBe("my-app");
    expect(result.environment).toBe("production");
    expect(result.taskQueue.concurrency).toBe(20);
    // Other taskQueue fields should still have defaults
    expect(result.taskQueue.heartbeatMs).toBe(5000);
  });

  it("validates cron configuration", () => {
    const result = OqronConfigSchema.parse({
      cron: {
        tickInterval: 500,
        maxConcurrentJobs: 10,
        missedFirePolicy: "run-all",
      },
    });
    expect(result.cron.tickInterval).toBe(500);
    expect(result.cron.maxConcurrentJobs).toBe(10);
    expect(result.cron.missedFirePolicy).toBe("run-all");
  });

  it("validates scheduler configuration", () => {
    const result = OqronConfigSchema.parse({
      scheduler: { tickInterval: 2000, leaderElection: false },
    });
    expect(result.scheduler.tickInterval).toBe(2000);
    expect(result.scheduler.leaderElection).toBe(false);
  });

  it("validates taskQueue retry configuration", () => {
    const result = OqronConfigSchema.parse({
      taskQueue: {
        retries: { max: 10, strategy: "fixed", baseDelay: 5000 },
      },
    });
    expect(result.taskQueue.retries.max).toBe(10);
    expect(result.taskQueue.retries.strategy).toBe("fixed");
  });

  it("validates worker strategy", () => {
    const result = OqronConfigSchema.parse({
      worker: { strategy: "priority" },
    });
    expect(result.worker.strategy).toBe("priority");
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

describe("reconfigureConfig — Deep Merge", () => {
  it("merges user config with defaults", () => {
    const result = reconfigureConfig({ project: "custom-name" });
    expect(result.project).toBe("custom-name");
    expect(result.environment).toBe("development"); // default preserved
  });

  it("deep-merges cron lagMonitor", () => {
    const result = reconfigureConfig({
      cron: { lagMonitor: { maxLagMs: 10000 } },
    });
    expect(result.cron.lagMonitor.maxLagMs).toBe(10000);
    expect(result.cron.lagMonitor.sampleIntervalMs).toBe(1000); // default preserved
  });

  it("deep-merges taskQueue retries", () => {
    const result = reconfigureConfig({
      taskQueue: { retries: { max: 10 } },
    });
    expect(result.taskQueue.retries.max).toBe(10);
    expect(result.taskQueue.retries.strategy).toBe("exponential"); // default
    expect(result.taskQueue.retries.baseDelay).toBe(2000); // default
  });

  it("deep-merges worker deadLetter", () => {
    const result = reconfigureConfig({
      worker: { deadLetter: { enabled: false } },
    });
    expect(result.worker.deadLetter.enabled).toBe(false);
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

  it("strategy defaults to fifo", () => {
    const result = reconfigureConfig({});
    expect(result.taskQueue.strategy).toBe("fifo");
    expect(result.worker.strategy).toBe("fifo");
  });
});
