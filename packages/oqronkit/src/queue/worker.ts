import { Broker } from "../engine/index.js";
import type { BrokerStrategy, IBrokerEngine } from "../engine/types/engine.js";
import type { OqronJob } from "../engine/types/job.types.js";

export interface WorkerOptions {
  connection?: IBrokerEngine; // Optional override
  concurrency?: number;
  autorun?: boolean; // Defaults to matching OqronKit lifecycle natively
  /** Job ordering strategy. @default "fifo" */
  strategy?: BrokerStrategy;
  limiter?: {
    max: number;
    duration: number;
    groupKey?: string;
  };
  /** Retry config override for this worker. Deep-merged with global config. */
  retries?: {
    max?: number;
    strategy?: "fixed" | "exponential";
    baseDelay?: number;
    maxDelay?: number;
  };
  /** Dead letter queue hooks */
  deadLetter?: {
    enabled?: boolean;
    onDead?: (job: OqronJob<any, any>) => Promise<void>;
  };
  /** Auto-remove completed jobs. Overrides global config. */
  removeOnComplete?: import("../engine/types/job.types.js").RemoveOnConfig;
  /** Auto-remove failed jobs. Overrides global config. */
  removeOnFail?: import("../engine/types/job.types.js").RemoveOnConfig;
  /** Callbacks executed directly on the CPU node doing the worker processing natively */
  hooks?: {
    onSuccess?: (job: OqronJob<any, any>, result: any) => Promise<void> | void;
    onFail?: (job: OqronJob<any, any>, error: Error) => Promise<void> | void;
  };
}

// Internal registry tracking all Worker instances
const registeredWorkers: Worker<any, any>[] = [];

export function getRegisteredWorkers(): Worker<any, any>[] {
  return registeredWorkers;
}

/**
 * Enterprise Distributed Worker.
 * Modeled after Industrygrade. Strongly isolated CPU polling decoupled from senders.
 */
export class Worker<T = any, R = any> {
  public running: boolean = false;

  constructor(
    public readonly name: string,
    public readonly processor: string | ((job: OqronJob<T, R>) => Promise<R>),
    public readonly options?: WorkerOptions,
  ) {
    // Automatically register this worker into OqronKit's engine lifecycle
    registeredWorkers.push(this);

    // Auto-run compatibility if someone explicitly sets it up outside standard DI container
    if (this.options?.autorun !== false) {
      // In OqronKit we typically defer to OqronKit.start(), but Industrygrade autoruns.
      // We will let the central `WorkerEngine` trigger `.run()` during boot to keep standard.
    }
  }

  getAdapter(): IBrokerEngine {
    const adapter = this.options?.connection ?? Broker;
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
