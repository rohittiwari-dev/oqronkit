import type { FlowJobNode, OqronJob } from "../../core/types/job.types.js";
import { OqronKit } from "../../index.js";

export interface FlowProducerOptions {
  // connection override TBD
  connection?: unknown;
}

/**
 * Enterprise Flow Producer.
 * Handles complex Parent-Child DAG dependencies.
 *
 * FlowProducer is a DB-heavy component that builds the job tree in the storage layer.
 */
export class FlowProducer {
  constructor(_options?: FlowProducerOptions) {}

  /**
   * Pushes a recursive flow tree into the system.
   */
  async add(flow: FlowJobNode): Promise<OqronJob> {
    const db = OqronKit.getDb();
    return await db.enqueueFlow(flow);
  }
}
