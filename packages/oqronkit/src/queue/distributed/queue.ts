import type {
  IQueueAdapter,
  OqronJobData,
  OqronJobOptions,
} from "../../core/types/queue.types.js";
import { getTaskQueueAdapter } from "../../task-queue/registry.js"; // or similar central queue registry

export interface QueueOptions {
  connection?: IQueueAdapter; // Optional override. Defaults to global OqronKit adapter
  defaultJobOptions?: OqronJobOptions;
}

/**
 * Enterprise Queue Publisher.
 * Modeled after BullMQ. This class is strictly a sender and consumes no CPU/polling loops.
 * Extremely safe to deploy on lightweight API edge-nodes.
 */
export class Queue<T = any, R = any> {
  constructor(
    public readonly name: string,
    private options?: QueueOptions,
  ) {}

  /**
   * Dynamically fetch the adapter if not provided explicitly.
   */
  private getAdapter(): IQueueAdapter {
    const adapter = this.options?.connection ?? getTaskQueueAdapter();
    if (!adapter) {
      throw new Error(
        `[OqronKit] Queue '${this.name}' has no connection. ` +
          `Pass { connection: adapter } or ensure OqronKit.init() has successfully run.`,
      );
    }
    return adapter;
  }

  /**
   * Pushes a new job into the persistent data store.
   */
  async add(
    _name: string,
    data: T,
    opts?: OqronJobOptions,
  ): Promise<OqronJobData<T, R>> {
    const adapter = this.getAdapter();
    const finalOpts = { ...this.options?.defaultJobOptions, ...opts };

    // Push the job context to adapter
    const res = await adapter.enqueue<T>(this.name, data, finalOpts);
    return res as unknown as OqronJobData<T, R>;
  }

  /**
   * Push multiple jobs asynchronously in bulk.
   */
  async addBulk(
    jobs: { name: string; data: T; opts?: OqronJobOptions }[],
  ): Promise<OqronJobData<T, R>[]> {
    const adapter = this.getAdapter();
    const mapped = jobs.map((j) => ({
      data: j.data,
      opts: { ...this.options?.defaultJobOptions, ...j.opts },
    }));
    const result = await adapter.enqueueBulk<T>(this.name, mapped);
    return result as unknown as OqronJobData<T, R>[];
  }

  async close(): Promise<void> {
    // For BullMQ compatibility, though connection management is generic
  }
}
