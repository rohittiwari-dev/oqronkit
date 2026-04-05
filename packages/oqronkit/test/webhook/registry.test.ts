import { describe, expect, it, beforeEach } from "vitest";
import {
  registerWebhook,
  getRegisteredWebhooks,
  clearWebhooks,
} from "../../src/webhook/registry.js";
import type { WebhookConfig } from "../../src/webhook/types.js";

describe("Webhook Registry", () => {
  beforeEach(() => {
    clearWebhooks();
  });

  it("should register a webhook by config.name", () => {
    const config: WebhookConfig = { name: "test-reg-1", endpoints: [] };
    registerWebhook(config);
    const result = getRegisteredWebhooks();
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(config);
    expect(result[0].name).toBe("test-reg-1");
  });

  it("should register multiple webhooks", () => {
    registerWebhook({ name: "a", endpoints: [] });
    registerWebhook({ name: "b", endpoints: [] });
    registerWebhook({ name: "c", endpoints: [] });
    expect(getRegisteredWebhooks()).toHaveLength(3);
  });

  it("should overwrite a webhook with the same name", () => {
    const config1: WebhookConfig = { name: "dup", endpoints: [] };
    const config2: WebhookConfig = {
      name: "dup",
      endpoints: [{ name: "ep", url: "http://x.com", events: ["*"] }],
    };
    registerWebhook(config1);
    registerWebhook(config2);
    const result = getRegisteredWebhooks();
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(config2);
  });

  it("should return an array (not a Map)", () => {
    registerWebhook({ name: "x", endpoints: [] });
    const result = getRegisteredWebhooks();
    expect(Array.isArray(result)).toBe(true);
  });

  it("should clear all webhooks", () => {
    registerWebhook({ name: "a", endpoints: [] });
    registerWebhook({ name: "b", endpoints: [] });
    expect(getRegisteredWebhooks()).toHaveLength(2);
    clearWebhooks();
    expect(getRegisteredWebhooks()).toHaveLength(0);
  });
});
