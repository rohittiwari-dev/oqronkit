import type { SubscriptionConfig, TopicConfig } from "./types.js";

const TOPICS_KEY = Symbol.for("oqronkit:pending_pubsub_topics");
const SUBSCRIPTIONS_KEY = Symbol.for("oqronkit:pending_pubsub_subscriptions");

type PendingSubscription = {
  topicName: string;
  config: SubscriptionConfig;
};

type GlobalRegistry = typeof globalThis & {
  [key: symbol]: TopicConfig[] | PendingSubscription[] | undefined;
};

function getTopicList(): TopicConfig[] {
  const g = globalThis as GlobalRegistry;
  if (!g[TOPICS_KEY]) g[TOPICS_KEY] = [];
  return g[TOPICS_KEY] as TopicConfig[];
}

function getSubscriptionList(): PendingSubscription[] {
  const g = globalThis as GlobalRegistry;
  if (!g[SUBSCRIPTIONS_KEY]) g[SUBSCRIPTIONS_KEY] = [];
  return g[SUBSCRIPTIONS_KEY] as PendingSubscription[];
}

export function registerTopic(config: TopicConfig): void {
  const topics = getTopicList();
  const existing = topics.findIndex((topic) => topic.name === config.name);
  if (existing >= 0) {
    topics[existing] = config;
  } else {
    topics.push(config);
  }
}

export function getRegisteredTopics(): TopicConfig[] {
  return getTopicList();
}

export function registerPendingSubscription(
  topicName: string,
  config: SubscriptionConfig,
): void {
  getSubscriptionList().push({ topicName, config });
}

export function drainPendingSubscriptions(): PendingSubscription[] {
  const subscriptions = getSubscriptionList();
  return subscriptions.splice(0, subscriptions.length);
}
