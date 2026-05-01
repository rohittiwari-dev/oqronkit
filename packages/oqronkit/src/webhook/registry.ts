import type { WebhookConfig } from "./types.js";

const webhooks = new Map<string, WebhookConfig>();

export function registerWebhook(config: WebhookConfig): void {
  webhooks.set(config.name, config);
}

export function getRegisteredWebhooks(): WebhookConfig[] {
  return Array.from(webhooks.values());
}

export function getWebhookByName(name: string): WebhookConfig | undefined {
  return webhooks.get(name);
}

export function deregisterWebhook(name: string): boolean {
  return webhooks.delete(name);
}

export function clearWebhooks(): void {
  webhooks.clear();
}
