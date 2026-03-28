import type { IQueueAdapter, OqronJobData } from "../core/types/queue.types.js";
import { getTaskQueueAdapter } from "../task-queue/registry.js"; // or similar

export interface WorkerOptions {
  connection?: IQueueAdapter; // Optional override
  concurrency?: number;
  autorun?: boolean; // Defaults to matching OqronKit lifecycle natively
  limiter?: {
    max: number;
    duration: number;
    groupKey?: string;
  };
}

// Internal registry tracking all Worker instances
const registeredWorkers: Worker<any, any>[] = [];

export function getRegisteredWorkers(): Worker<any, any>[] {
  return registeredWorkers;
}

/**
 * Enterprise Distributed Worker.
 * Modeled after BullMQ. Strongly isolated CPU polling decoupled from senders.
 */
export class Worker<T = any, R = any> {
  public running: boolean = false;

  constructor(
    public readonly name: string,
    public readonly processor: (job: OqronJobData<T, R>) => Promise<R>,
    public readonly options?: WorkerOptions,
  ) {
    // Automatically register this worker into OqronKit's engine lifecycle
    registeredWorkers.push(this);

    // Auto-run compatibility if someone explicitly sets it up outside standard DI container
    if (this.options?.autorun !== false) {
      // In OqronKit we typically defer to OqronKit.start(), but BullMQ autoruns.
      // We will let the central `WorkerEngine` trigger `.run()` during boot to keep standard.
    }
  }

  getAdapter(): IQueueAdapter {
    const adapter = this.options?.connection ?? getTaskQueueAdapter();
    if (!adapter)
      throw new Error(
        `[OqronKit] Worker '${this.name}' has no active adapter.`,
      );
    return adapter;
  }

  // Internal OqronKit invocation hooks
  start() {
    this.running = true;
  }

  stop() {
    this.running = false;
  }
}
