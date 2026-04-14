import type { WorkerConfig } from "./types.js";

const registeredWorkers: WorkerConfig[] = [];

/**
 * Registers a worker config for the engine to pick up.
 */
export function registerWorker(config: WorkerConfig): void {
  // If a worker with this topic already exists, replace it
  const existingIndex = registeredWorkers.findIndex((w) => w.topic === config.topic);
  if (existingIndex > -1) {
    registeredWorkers[existingIndex] = config;
  } else {
    registeredWorkers.push(config);
  }
}

/**
 * Gets all registered worker configurations.
 */
export function getRegisteredWorkers(): WorkerConfig[] {
  return registeredWorkers;
}
