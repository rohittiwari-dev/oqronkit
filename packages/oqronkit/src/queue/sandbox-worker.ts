import { Worker as NodeWorker } from "node:worker_threads";
import type { OqronJob } from "../engine/types/job.types.js";

/**
 * Configuration for sandboxed processor execution.
 */
export interface SandboxOptions {
  /** Enable worker_threads isolation. @default false */
  enabled: boolean;
  /** Max execution time in ms before force-kill. @default 30000 */
  timeout?: number;
  /** Max old-generation heap in MB (sets resourceLimits). @default 512 */
  maxMemoryMb?: number;
  /** Transfer only serializable data (structured clone). @default true */
  transferOnly?: boolean;
}

/**
 * SandboxWorker — executes a processor in an isolated worker_thread
 * with resource limits and timeout enforcement.
 *
 * For untrusted handler code: prevents memory leaks, infinite loops,
 * and access to the parent thread's heap.
 *
 * @example
 * ```ts
 * const sandbox = new SandboxWorker({
 *   enabled: true,
 *   timeout: 15_000,
 *   maxMemoryMb: 256,
 * });
 * const result = await sandbox.execute("./processors/image.js", job);
 * ```
 */
export class SandboxWorker {
  private thread: NodeWorker | null = null;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: SandboxOptions) {}

  /**
   * Execute a processor module in an isolated worker_thread.
   *
   * The processor file must export a default async function
   * that receives the job and returns a result:
   * ```ts
   * export default async function(job) { return { processed: true }; }
   * ```
   */
  async execute<T, R>(processorPath: string, job: OqronJob<T, R>): Promise<R> {
    const maxMemoryMb = this.opts.maxMemoryMb ?? 512;
    const timeout = this.opts.timeout ?? 30_000;

    return new Promise<R>((resolve, reject) => {
      // Create worker thread with resource limits
      this.thread = new NodeWorker(processorPath, {
        workerData: {
          job: JSON.parse(JSON.stringify(job)), // Deep clone for safety
        },
        resourceLimits: {
          maxOldGenerationSizeMb: maxMemoryMb,
          maxYoungGenerationSizeMb: Math.floor(maxMemoryMb / 4),
          codeRangeSizeMb: 64,
        },
      });

      // Set execution timeout
      this.timeoutHandle = setTimeout(() => {
        this.terminate();
        reject(
          new Error(
            `Sandboxed processor timed out after ${timeout}ms: ${processorPath}`,
          ),
        );
      }, timeout);

      // Listen for result
      this.thread.on("message", (result: R) => {
        this.cleanup();
        resolve(result);
      });

      // Listen for errors
      this.thread.on("error", (err: Error) => {
        this.cleanup();
        reject(err);
      });

      // Listen for abnormal exits
      this.thread.on("exit", (code) => {
        this.cleanup();
        if (code !== 0) {
          reject(
            new Error(
              `Sandboxed processor exited with code ${code}: ${processorPath}`,
            ),
          );
        }
      });
    });
  }

  /**
   * Force-terminate the worker thread.
   */
  terminate(): void {
    if (this.thread) {
      this.thread.terminate().catch(() => {});
      this.thread = null;
    }
    this.cleanup();
  }

  private cleanup(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }
}
