import type { IQueueAdapter } from "../core/types/queue.types.js";
import { OqronKit } from "../index.js";
import type { TaskQueueConfig } from "./types.js";

const registeredTaskQueues: TaskQueueConfig[] = [];
let queueAdapter: IQueueAdapter | null = null;

export function registerTaskQueue(config: TaskQueueConfig): void {
  // Overwrite if it exists (for HMR)
  const existing = registeredTaskQueues.findIndex(
    (q) => q.name === config.name,
  );
  if (existing > -1) {
    registeredTaskQueues[existing] = config;
  } else {
    registeredTaskQueues.push(config);
  }
}

export function getRegisteredTaskQueues(): TaskQueueConfig[] {
  return registeredTaskQueues;
}

export function injectTaskQueueAdapter(adapter: IQueueAdapter): void {
  queueAdapter = adapter;
}

export function getTaskQueueAdapter(): IQueueAdapter | null {
  if (queueAdapter) return queueAdapter;
  try {
    return OqronKit.getBroker();
  } catch {
    return null;
  }
}
