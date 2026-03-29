import type { FlowJobNode, OqronJob } from "../../engine/types/job.types.js";

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
  async add(_flow: FlowJobNode): Promise<OqronJob> {
    // We will need a specialized method on Storage or a utility to enqueue flows
    // For now, we stub this out as it requires specific implementation logic
    // built on top of the generic Storage engine.
    throw new Error(
      "FlowProducer.add not fully adapted to new Storage engine yet.",
    );
  }
}
