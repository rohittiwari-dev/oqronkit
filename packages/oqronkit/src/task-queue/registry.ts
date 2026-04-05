import type { TaskQueueConfig } from "./types.js";

const registeredTaskQueues: TaskQueueConfig[] = [];

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
