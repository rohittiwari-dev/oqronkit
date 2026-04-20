import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import type { Logger } from "../logger/index.js";

/**
 * F8: Sandboxed Processor
 *
 * Executes job handlers in an isolated `worker_threads` context, providing:
 *
 * 1. **Crash isolation** — if the handler crashes (OOM, segfault, infinite loop),
 *    only the child thread dies; the main event loop survives.
 *
 * 2. **Timeout enforcement** — hard kills the thread after `timeoutMs`,
 *    even if the handler ignores AbortSignal or is stuck in native code.
 *
 * 3. **Memory limits** — configurable V8 heap limit per thread via
 *    `resourceLimits.maxOldGenerationSizeMb`.
 *
 * **Usage:**
 * ```ts
 * const sandbox = new SandboxedProcessor({
 *   handlerPath: './handlers/email.js',  // Path to the handler module
 *   handlerExport: 'default',            // Named export to call
 *   timeoutMs: 30000,
 *   maxOldGenerationSizeMb: 128,
 * });
 *
 * const result = await sandbox.execute({ to: 'user@example.com' });
 * ```
 *
 * **Handler module contract:** The handler file must export a function
 * matching `(data: any) => Promise<any>`. It receives serialized job data
 * and returns serialized results via the worker_threads message channel.
 */
export interface SandboxedProcessorConfig {
  /** Absolute path to the handler module file */
  handlerPath: string;
  /** Named export to call. @default "default" */
  handlerExport?: string;
  /** Hard timeout in ms. Thread is terminated after this. @default 30000 */
  timeoutMs?: number;
  /** V8 max old-generation heap size in MB. @default 128 */
  maxOldGenerationSizeMb?: number;
  /** V8 max young-generation heap size in MB. @default undefined */
  maxYoungGenerationSizeMb?: number;
  /** Stack size in KB. @default undefined (V8 default) */
  stackSizeMb?: number;
}

export interface SandboxResult<R = any> {
  success: boolean;
  result?: R;
  error?: string;
  durationMs: number;
  /** Whether the thread was killed due to timeout */
  timedOut: boolean;
  /** Whether the thread crashed (non-zero exit code) */
  crashed: boolean;
}

/**
 * The inline worker script that bootstraps the handler module.
 * It receives job data via parentPort message, imports the handler,
 * calls it, and posts the result back.
 */
const WORKER_BOOTSTRAP = `
const { parentPort, workerData } = require('worker_threads');
const { pathToFileURL } = require('url');

(async () => {
  try {
    // Convert OS path to file:// URL for ESM import compatibility (Windows requires this)
    const handlerUrl = pathToFileURL(workerData.handlerPath).href;
    const mod = await import(handlerUrl);
    const handler = mod[workerData.handlerExport] || mod.default;
    if (typeof handler !== 'function') {
      throw new Error('Handler export "' + workerData.handlerExport + '" is not a function');
    }
    const result = await handler(workerData.jobData);
    parentPort.postMessage({ type: 'result', value: result });
  } catch (err) {
    parentPort.postMessage({
      type: 'error',
      message: err?.message || String(err),
      stack: err?.stack,
    });
  }
})();
`;

export class SandboxedProcessor {
  constructor(
    private readonly config: SandboxedProcessorConfig,
    private readonly logger?: Logger,
  ) {}

  /**
   * Execute a job payload in a sandboxed worker thread.
   */
  async execute<T = any, R = any>(jobData: T): Promise<SandboxResult<R>> {
    const startTime = Date.now();
    const timeoutMs = this.config.timeoutMs ?? 30_000;
    const handlerExport = this.config.handlerExport ?? "default";

    return new Promise<SandboxResult<R>>((resolve) => {
      let settled = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

      const worker = new Worker(WORKER_BOOTSTRAP, {
        eval: true,
        workerData: {
          handlerPath: this.config.handlerPath,
          handlerExport,
          jobData,
        },
        resourceLimits: {
          maxOldGenerationSizeMb: this.config.maxOldGenerationSizeMb ?? 128,
          ...(this.config.maxYoungGenerationSizeMb
            ? { maxYoungGenerationSizeMb: this.config.maxYoungGenerationSizeMb }
            : {}),
          ...(this.config.stackSizeMb
            ? { stackSizeMb: this.config.stackSizeMb }
            : {}),
        },
      });

      const settle = (result: SandboxResult<R>) => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        resolve(result);
      };

      // Message from worker
      worker.on("message", (msg: any) => {
        if (msg.type === "result") {
          settle({
            success: true,
            result: msg.value,
            durationMs: Date.now() - startTime,
            timedOut: false,
            crashed: false,
          });
        } else if (msg.type === "error") {
          settle({
            success: false,
            error: msg.message,
            durationMs: Date.now() - startTime,
            timedOut: false,
            crashed: false,
          });
        }
      });

      // Worker crashed
      worker.on("error", (err) => {
        this.logger?.error("Sandboxed processor thread error", {
          error: err.message,
          handlerPath: this.config.handlerPath,
        });
        settle({
          success: false,
          error: err.message,
          durationMs: Date.now() - startTime,
          timedOut: false,
          crashed: true,
        });
      });

      // Worker exited (possibly due to OOM or terminate)
      worker.on("exit", (code) => {
        if (code !== 0) {
          settle({
            success: false,
            error: `Worker thread exited with code ${code}`,
            durationMs: Date.now() - startTime,
            timedOut: false,
            crashed: true,
          });
        }
      });

      // Hard timeout — kill the thread
      timeoutHandle = setTimeout(() => {
        this.logger?.warn("Sandboxed processor timed out, terminating thread", {
          timeoutMs,
          handlerPath: this.config.handlerPath,
        });
        worker.terminate().catch(() => {});
        settle({
          success: false,
          error: `Sandboxed handler timed out after ${timeoutMs}ms`,
          durationMs: Date.now() - startTime,
          timedOut: true,
          crashed: false,
        });
      }, timeoutMs);
      timeoutHandle.unref?.();
    });
  }
}
