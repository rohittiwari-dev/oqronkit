import { OqronRegistry } from "../engine/registry.js";
import { registerPendingSubscription, registerTopic } from "./registry.js";
import type {
  ITopic,
  PubSubPublishOptions,
  SubscriptionConfig,
  TopicConfig,
} from "./types.js";

export function topic<T = any>(config: TopicConfig<T>): ITopic<T> {
  registerTopic(config);

  function resolve(): ITopic<T> {
    const module = OqronRegistry.getInstance().get("pubsub") as
      | { registerTopic<TValue>(config: TopicConfig<TValue>): ITopic<TValue> }
      | undefined;
    if (!module) {
      throw new Error(
        `[OqronKit] PubSub topic "${config.name}" requires modules: [pubsubModule()].`,
      );
    }
    return module.registerTopic(config);
  }

  return {
    name: config.name,
    publish: (message: T, options?: PubSubPublishOptions) =>
      resolve().publish(message, options),
    publishBatch: (messages) => resolve().publishBatch(messages),
    subscribe: async (subscription: SubscriptionConfig<T>) => {
      const module = OqronRegistry.getInstance().get("pubsub") as
        | { registerTopic<TValue>(config: TopicConfig<TValue>): ITopic<TValue> }
        | undefined;
      if (!module) {
        registerPendingSubscription(config.name, subscription);
        return async () => {};
      }
      return module.registerTopic(config).subscribe(subscription);
    },
    replay: (opts) => resolve().replay(opts),
    seek: (group, opts) => resolve().seek(group, opts),
    stats: () => resolve().stats(),
    lag: (group?: string) => resolve().lag(group),
    purge: () => resolve().purge(),
    pause: (group?: string) => resolve().pause(group),
    resume: (group?: string) => resolve().resume(group),
    deadLetters: (group, opts) => resolve().deadLetters(group, opts),
    retryDeadLetter: (group, messageId) =>
      resolve().retryDeadLetter(group, messageId),
    retryAllDeadLetters: (group) => resolve().retryAllDeadLetters(group),
  };
}
