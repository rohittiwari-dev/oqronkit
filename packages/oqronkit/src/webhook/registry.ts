import type { WebhookConfig } from "./types.js";

const webhooks = new Map<string, WebhookConfig>();

export function registerWebhook(config: WebhookConfig): void {
  webhooks.set(config.name, config);
}

export function getRegisteredWebhooks(): WebhookConfig[] {
  return Array.from(webhooks.values());
}

export function clearWebhooks(): void {
  webhooks.clear();
}
