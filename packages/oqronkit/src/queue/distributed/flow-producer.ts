import type {
  FlowJobNode,
  IQueueAdapter,
  OqronJobData,
} from "../../core/types/queue.types.js";
import { getTaskQueueAdapter } from "../../task-queue/registry.js";

export interface FlowProducerOptions {
  connection?: IQueueAdapter;
}

/**
 * Enterprise Distributed Flow Producer.
 * Matches BullMQ architectures for inserting complex Directed Acyclic Graph (DAG) dependencies.
 */
export class FlowProducer {
  constructor(private options?: FlowProducerOptions) {}

  getAdapter(): IQueueAdapter {
    const adapter = this.options?.connection ?? getTaskQueueAdapter();
    if (!adapter) {
      throw new Error(
        `[OqronKit] FlowProducer has no connection. ` +
          `Pass { connection: adapter } or ensure OqronKit.init() has successfully run.`,
      );
    }
    return adapter;
  }

  /**
   * Add a recursive dependency map where the parent `name` strictly waits until
   * all `children` finish execution across any queue natively.
   */
  async add(flow: FlowJobNode): Promise<OqronJobData> {
    const adapter = this.getAdapter();
    return await adapter.enqueueFlow(flow);
  }
}
