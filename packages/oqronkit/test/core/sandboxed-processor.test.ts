import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SandboxedProcessor } from "../../src/engine/sandbox/sandboxed-processor.js";
import { createLogger } from "../../src/engine/logger/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HANDLER_PATH = path.resolve(__dirname, "fixtures/sandbox-handler.mjs");

const logger = createLogger({ enabled: false }, { module: "test" });

describe("F8: SandboxedProcessor", () => {
  it("executes a handler in a worker thread and returns result", async () => {
    const sandbox = new SandboxedProcessor(
      {
        handlerPath: HANDLER_PATH,
        handlerExport: "default",
        timeoutMs: 5000,
      },
      logger,
    );

    const result = await sandbox.execute({ x: 21 });

    expect(result.success).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.crashed).toBe(false);
    expect(result.result).toEqual({ echo: { x: 21 }, computed: 42 });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("captures handler errors without crashing the main thread", async () => {
    const sandbox = new SandboxedProcessor(
      {
        handlerPath: HANDLER_PATH,
        handlerExport: "failingHandler",
        timeoutMs: 5000,
      },
      logger,
    );

    const result = await sandbox.execute({ x: 1 });

    expect(result.success).toBe(false);
    expect(result.error).toContain("handler-explosion");
    expect(result.timedOut).toBe(false);
    expect(result.crashed).toBe(false);
  });

  it("hard-kills the worker thread on timeout", async () => {
    const sandbox = new SandboxedProcessor(
      {
        handlerPath: HANDLER_PATH,
        handlerExport: "slowHandler",
        timeoutMs: 200, // Very short timeout
      },
      logger,
    );

    const result = await sandbox.execute({ x: 1 });

    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain("timed out");
    expect(result.durationMs).toBeGreaterThanOrEqual(150);
    expect(result.durationMs).toBeLessThan(2000); // Should not take 60s
  });

  it("reports crashed=true for invalid handler path", async () => {
    const sandbox = new SandboxedProcessor(
      {
        handlerPath: "/nonexistent/handler.mjs",
        timeoutMs: 5000,
      },
      logger,
    );

    const result = await sandbox.execute({ x: 1 });

    expect(result.success).toBe(false);
    // Either crashed or error, depending on how worker_threads handles it
    expect(result.crashed || result.error).toBeTruthy();
  });
});
