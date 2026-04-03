import type { QueueConfig } from "./types.js";

const registeredQueues: QueueConfig[] = [];

export function registerQueue(config: QueueConfig): void {
  // Overwrite if it exists (for HMR)
  const existing = registeredQueues.findIndex((q) => q.name === config.name);
  if (existing > -1) {
    registeredQueues[existing] = config;
  } else {
    registeredQueues.push(config);
  }
}

export function getRegisteredQueues(): QueueConfig[] {
  return registeredQueues;
}
