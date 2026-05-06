import type { WebhookConfig } from "./types.js";

const GLOBAL_KEY = Symbol.for("oqronkit:webhook_registry");

type GlobalRegistry = typeof globalThis & {
  [key: symbol]: Map<string, WebhookConfig> | undefined;
};

function getRegistry(): Map<string, WebhookConfig> {
  const g = globalThis as unknown as GlobalRegistry;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new Map();
  return g[GLOBAL_KEY]!;
}

export function registerWebhook(config: WebhookConfig): void {
  getRegistry().set(config.name, config);
}

export function getRegisteredWebhooks(): WebhookConfig[] {
  return Array.from(getRegistry().values());
}

export function getWebhookByName(name: string): WebhookConfig | undefined {
  return getRegistry().get(name);
}

export function deregisterWebhook(name: string): boolean {
  return getRegistry().delete(name);
}

export function clearWebhooks(): void {
  getRegistry().clear();
}
