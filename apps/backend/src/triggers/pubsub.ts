/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  OqronKit — PubSub Module Examples
 *  Real-world production examples showcasing the topic() API.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *  topic() creates a durable, partitioned message topic. Subscriptions are
 *  registered separately via .subscribe() — they are NOT inline in the config.
 *
 *  Features demonstrated:
 *  ✓ Topic creation with distribution (partitions, hash strategy)
 *  ✓ Publishing with partitionKey + idempotencyKey
 *  ✓ Multiple consumer groups via .subscribe() (independent offsets)
 *  ✓ Auto-ack and manual-ack modes
 *  ✓ Retry + dead letter on handler failure
 *  ✓ Partition-key ordering guarantees
 *  ✓ Message validation
 *  ✓ Publish hooks
 */

import { topic } from "oqronkit";

// ─────────────────────────────────────────────────────────────────────────────
// 1. ORDER EVENTS TOPIC
//    Partitioned by orderId for ordering guarantees.
//    Consumer groups are registered via .subscribe() calls below.
// ─────────────────────────────────────────────────────────────────────────────
type OrderEvent = {
  orderId: string;
  type:
    | "order.created"
    | "order.paid"
    | "order.shipped"
    | "order.delivered"
    | "order.cancelled";
  customerId: string;
  amount: number;
  currency: string;
  timestamp: string;
};

export const orderEventsTopic = topic<OrderEvent>({
  name: "order-events",

  distribution: {
    partitions: 4,
    strategy: "hash",
  },

  retention: {
    maxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
    maxCount: 100_000,
  },

  validate: (msg) => {
    if (!msg.orderId) return "orderId is required";
    if (!msg.type) return "type is required";
    return true;
  },

  hooks: {
    onPublish: async (message, messageId) => {
      console.log(
        `📤 [order-events] Published: ${message.type} (${messageId})`,
      );
    },
    onDead: async (messageId, group, error) => {
      console.error(
        `☠️ [order-events] Dead letter in ${group}: ${messageId} — ${error.message}`,
      );
    },
  },
});

// ── Consumer Group 1: Billing Service ──
// Processes payment-related events. Auto-ack mode.
orderEventsTopic.subscribe({
  group: "billing-service",
  batchSize: 10,
  ackMode: "auto",

  retries: {
    max: 3,
    strategy: "exponential",
    baseDelay: 2000,
  },

  deadLetter: {
    enabled: true,
    onDead: async (messageId, _message, error) => {
      console.error(
        `☠️ [billing] Dead letter: ${messageId} — ${error.message}`,
      );
    },
  },

  handler: async (ctx) => {
    const { type, orderId, amount, currency } = ctx.message;

    if (type === "order.paid") {
      ctx.log.info(
        `💰 [billing] Processing payment for order ${orderId}: ${currency} ${amount}`,
      );
      await new Promise((r) => setTimeout(r, 100));
    }

    if (type === "order.cancelled") {
      ctx.log.info(`💸 [billing] Processing refund for order ${orderId}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  },
});

// ── Consumer Group 2: Analytics Service ──
// Consumes ALL order events for data warehouse ingestion.
orderEventsTopic.subscribe({
  group: "analytics-service",
  batchSize: 50,
  ackMode: "auto",

  handler: async (ctx) => {
    const { type, orderId } = ctx.message;
    ctx.log.info(
      `📈 [analytics] Ingesting event ${type} for order ${orderId}`,
    );
    await new Promise((r) => setTimeout(r, 10));
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. NOTIFICATION EVENTS TOPIC
//    Fan-out notifications to multiple channels.
//    Single consumer group with manual ack for critical delivery.
// ─────────────────────────────────────────────────────────────────────────────
type NotificationEvent = {
  userId: string;
  channel: "email" | "sms" | "push" | "in-app";
  title: string;
  body: string;
  priority: "low" | "normal" | "high" | "urgent";
  metadata: Record<string, unknown>;
};

export const notificationTopic = topic<NotificationEvent>({
  name: "notifications",

  distribution: {
    partitions: 2,
    strategy: "hash",
  },

  retention: {
    maxAgeMs: 24 * 60 * 60 * 1000, // 24 hours
  },
});

// ── Consumer Group: Notification Dispatcher ──
// Manual ack mode — only ack after successful delivery.
notificationTopic.subscribe({
  group: "notification-dispatcher",
  batchSize: 5,
  ackMode: "manual",
  concurrency: 3,

  retries: {
    max: 5,
    strategy: "exponential",
    baseDelay: 1000,
    maxDelay: 30_000,
  },

  handler: async (ctx) => {
    const { userId, channel, title, priority } = ctx.message;
    ctx.log.info(
      `🔔 [${channel}] Sending "${title}" to user ${userId} (${priority})`,
    );

    try {
      // Simulate channel-specific dispatch
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));

      // Manual ack — only after successful delivery
      await ctx.ack();
    } catch {
      ctx.log.error(`❌ [${channel}] Delivery failed — nacking`);
      await ctx.nack();
    }
  },
});
