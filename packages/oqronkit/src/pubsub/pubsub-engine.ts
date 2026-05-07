import { createHash, randomUUID } from "node:crypto";
import { OqronContainer } from "../engine/container.js";
import { OqronEventBus } from "../engine/events/event-bus.js";
import type { Logger } from "../engine/logger/index.js";
import { calculateBackoff } from "../engine/utils/backoffs.js";
import type { PubSubModuleDef } from "../modules.js";
import type {
  ITopic,
  MessageContext,
  PubSubDeadLetterRecord,
  PubSubDeliveryRecord,
  PubSubGroupRecord,
  PubSubMessageRecord,
  PubSubPublishOptions,
  SubscriptionConfig,
  TopicConfig,
  TopicStats,
} from "./types.js";

const NS_MESSAGES = "pubsub_messages";
const NS_GROUPS = "pubsub_groups";
const NS_DELIVERIES = "pubsub_deliveries";
const NS_DEAD = "pubsub_dead_letters";
const NS_OFFSETS = "pubsub_offsets";
const NS_IDEMPOTENCY = "pubsub_idempotency";

type RuntimeSubscription<T> = {
  config: SubscriptionConfig<T>;
  consumerId: string;
  stopped: boolean;
  timer: ReturnType<typeof setInterval>;
  inFlight: Set<string>;
  activePartitions: Set<number>;
};

type SeekOptions =
  | { position: "earliest" | "latest" }
  | { offset: number }
  | { timestamp: Date | number }
  | { messageId: string };

const terminalDeliveryStates = new Set([
  "acked",
  "discarded",
  "dead",
  "filtered",
]);

export class PubSubTopicEngine<T = any> implements ITopic<T> {
  readonly name: string;

  private readonly subscriptions = new Map<string, RuntimeSubscription<T>>();

  constructor(
    private readonly topicConfig: TopicConfig<T>,
    private readonly moduleConfig: PubSubModuleDef,
    private readonly logger: Logger,
  ) {
    this.name = topicConfig.name;
  }

  private get di(): OqronContainer {
    return OqronContainer.get();
  }

  private get partitions(): number {
    const configured = this.topicConfig.distribution?.partitions ?? 1;
    return Math.max(1, Math.floor(configured));
  }

  async publish(
    message: T,
    options: PubSubPublishOptions = {},
  ): Promise<string> {
    const validation = this.topicConfig.validate?.(message);
    if (validation === false) {
      throw new Error(
        `[OqronKit] PubSub topic "${this.name}" rejected message.`,
      );
    }
    if (typeof validation === "string") {
      throw new Error(validation);
    }

    const existingId = await this.resolveExistingId(options);
    if (existingId) return existingId;

    const messageId = options.messageId ?? randomUUID();
    const partition = this.resolvePartition(message, options);
    const offset = await this.incrementOffset(partition);
    const payload = JSON.stringify(message);
    const now = Date.now();
    const record: PubSubMessageRecord = {
      id: messageId,
      topicName: this.name,
      partition,
      offset,
      payload,
      headers: options.headers ?? {},
      idempotencyKey: options.idempotencyKey,
      correlationId: options.correlationId,
      publishedAt: now,
      expiresAt: options.expiresAt
        ? new Date(options.expiresAt).getTime()
        : this.topicConfig.retention?.maxAgeMs
          ? now + this.topicConfig.retention.maxAgeMs
          : null,
      sizeBytes: Buffer.byteLength(payload),
      project: this.di.config?.project ?? "default",
      environment: this.di.config?.environment ?? "default",
      createdAt: new Date(now),
    };

    const inserted = await this.saveIfAbsent(NS_MESSAGES, messageId, record);
    if (!inserted) return messageId;

    if (options.idempotencyKey) {
      await this.saveIfAbsent(NS_IDEMPOTENCY, this.idempotencyKey(options), {
        messageId,
        createdAt: new Date(now),
      });
    }

    await this.createDeliveriesForMessage(record);
    await this.topicConfig.hooks?.onPublish?.(message, messageId, options);
    OqronEventBus.emit("pubsub:message:published", this.name, messageId);
    return messageId;
  }

  async publishBatch(
    messages: Array<{ message: T; options?: PubSubPublishOptions }>,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const item of messages) {
      ids.push(await this.publish(item.message, item.options));
    }
    return ids;
  }

  async stop(): Promise<void> {
    const subscriptions = Array.from(this.subscriptions.values());
    for (const runtime of subscriptions) {
      runtime.stopped = true;
      clearInterval(runtime.timer);
    }
    const deadline = Date.now() + (this.moduleConfig.shutdownTimeout ?? 25_000);
    while (
      subscriptions.some((runtime) => runtime.inFlight.size > 0) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    this.subscriptions.clear();
  }

  async subscribe(config: SubscriptionConfig<T>): Promise<() => Promise<void>> {
    if (this.subscriptions.has(config.group)) {
      throw new Error(
        `[OqronKit] PubSub group "${config.group}" is already subscribed to topic "${this.name}".`,
      );
    }

    await this.ensureGroup(config);
    await this.ensureDeliveriesForGroup(config.group, false);

    const runtime: RuntimeSubscription<T> = {
      config,
      consumerId: `pubsub-${this.name}-${config.group}-${randomUUID()}`,
      stopped: false,
      timer: setInterval(
        () => void this.pollSubscription(runtime),
        this.moduleConfig.pollIntervalMs ?? 100,
      ),
      inFlight: new Set(),
      activePartitions: new Set(),
    };
    runtime.timer.unref();
    this.subscriptions.set(config.group, runtime);
    void this.pollSubscription(runtime);

    return async () => {
      runtime.stopped = true;
      clearInterval(runtime.timer);
      this.subscriptions.delete(config.group);
      const deadline =
        Date.now() + (this.moduleConfig.shutdownTimeout ?? 25_000);
      while (runtime.inFlight.size > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
  }

  async replay(opts: { group: string; from: Date | number }): Promise<void> {
    if (opts.from instanceof Date) {
      await this.seek(opts.group, { timestamp: opts.from });
    } else {
      await this.seek(opts.group, { offset: opts.from });
    }
  }

  async seek(group: string, opts: SeekOptions): Promise<void> {
    const record = await this.getGroup(group);
    if (!record) {
      throw new Error(
        `[OqronKit] PubSub group "${group}" does not exist for topic "${this.name}".`,
      );
    }

    record.committedOffsets = await this.resolveSeekOffsets(
      opts,
      record.committedOffsets,
    );
    record.updatedAt = new Date();
    await this.di.storage.save(NS_GROUPS, record.id, record);
    await this.ensureDeliveriesForGroup(group, true);
  }

  async stats(): Promise<TopicStats> {
    const messages = await this.di.storage.list<PubSubMessageRecord>(
      NS_MESSAGES,
      { topicName: this.name },
      { limit: 100_000, orderBy: { field: "publishedAt", type: "number" } },
    );
    const groups = await this.getGroups();
    const groupStats = [];
    for (const group of groups) {
      const pendingMessages = await this.di.storage.count(NS_DELIVERIES, {
        topicName: this.name,
        groupName: group.groupName,
        status: "pending",
      });
      const deadLetterCount = await this.di.storage.count(NS_DEAD, {
        topicName: this.name,
        groupName: group.groupName,
      });
      groupStats.push({
        name: group.groupName,
        lag: await this.lag(group.groupName),
        activeConsumers: this.subscriptions.has(group.groupName) ? 1 : 0,
        pendingMessages,
        deadLetterCount,
        committedOffsets: group.committedOffsets,
      });
    }

    return {
      name: this.name,
      partitions: this.partitions,
      messageCount: messages.length,
      oldestMessageAt: messages[0]?.publishedAt ?? null,
      newestMessageAt: messages[messages.length - 1]?.publishedAt ?? null,
      groups: groupStats,
    };
  }

  async lag(group?: string): Promise<number> {
    const groups = group
      ? [await this.getGroup(group)]
      : await this.getGroups();
    let total = 0;
    for (const groupRecord of groups) {
      if (!groupRecord) continue;
      for (let partition = 0; partition < this.partitions; partition++) {
        const head = await this.getHeadOffset(partition);
        const committed = groupRecord.committedOffsets[String(partition)] ?? 0;
        total += Math.max(0, head - committed);
      }
    }
    return total;
  }

  async purge(): Promise<number> {
    const messages = await this.di.storage.list<PubSubMessageRecord>(
      NS_MESSAGES,
      { topicName: this.name },
      { limit: 100_000 },
    );
    const deliveries = await this.di.storage.list<PubSubDeliveryRecord>(
      NS_DELIVERIES,
      { topicName: this.name },
      { limit: 100_000 },
    );
    const dead = await this.di.storage.list<PubSubDeadLetterRecord>(
      NS_DEAD,
      { topicName: this.name },
      { limit: 100_000 },
    );
    await this.bulkDelete(
      NS_MESSAGES,
      messages.map((message) => message.id),
    );
    await this.bulkDelete(
      NS_DELIVERIES,
      deliveries.map((delivery) => delivery.id),
    );
    await this.bulkDelete(
      NS_DEAD,
      dead.map((entry) => entry.id),
    );
    for (const delivery of deliveries) {
      await this.di.broker.remove?.(
        this.brokerName(delivery.groupName, delivery.partition),
        delivery.id,
      );
    }
    return messages.length;
  }

  async pause(group?: string): Promise<void> {
    if (!group) {
      const groups = await this.getGroups();
      for (const groupRecord of groups) await this.pause(groupRecord.groupName);
      return;
    }
    const record = await this.getGroup(group);
    if (!record) return;
    record.status = "paused";
    record.updatedAt = new Date();
    await this.di.storage.save(NS_GROUPS, record.id, record);
    for (let partition = 0; partition < this.partitions; partition++) {
      await this.di.broker.pause(this.brokerName(group, partition));
    }
    OqronEventBus.emit("pubsub:group:paused", this.name, group);
  }

  async resume(group?: string): Promise<void> {
    if (!group) {
      const groups = await this.getGroups();
      for (const groupRecord of groups)
        await this.resume(groupRecord.groupName);
      return;
    }
    const record = await this.getGroup(group);
    if (!record) return;
    record.status = "active";
    record.updatedAt = new Date();
    await this.di.storage.save(NS_GROUPS, record.id, record);
    for (let partition = 0; partition < this.partitions; partition++) {
      await this.di.broker.resume(this.brokerName(group, partition));
    }
    await this.ensureDeliveriesForGroup(group, false);
    OqronEventBus.emit("pubsub:group:resumed", this.name, group);
  }

  async deadLetters(
    group: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<PubSubDeadLetterRecord[]> {
    return this.di.storage.list<PubSubDeadLetterRecord>(
      NS_DEAD,
      { topicName: this.name, groupName: group },
      {
        limit: opts?.limit ?? 100,
        offset: opts?.offset,
        orderBy: { field: "deadAt", direction: "desc", type: "number" },
      },
    );
  }

  async retryDeadLetter(group: string, messageId: string): Promise<void> {
    const entries = await this.di.storage.list<PubSubDeadLetterRecord>(
      NS_DEAD,
      { topicName: this.name, groupName: group, messageId },
      { limit: 1 },
    );
    const entry = entries[0];
    if (!entry) return;
    const delivery = await this.di.storage.get<PubSubDeliveryRecord>(
      NS_DELIVERIES,
      entry.deliveryId,
    );
    if (!delivery) return;
    delivery.status = "pending";
    delivery.error = undefined;
    delivery.nextRunAt = undefined;
    delivery.updatedAt = new Date();
    await this.di.storage.save(NS_DELIVERIES, delivery.id, delivery);
    await this.di.storage.delete(NS_DEAD, entry.id);
    await this.publishDelivery(delivery);
  }

  async retryAllDeadLetters(group: string): Promise<number> {
    const entries = await this.deadLetters(group, { limit: 100_000 });
    for (const entry of entries) {
      await this.retryDeadLetter(group, entry.messageId);
    }
    return entries.length;
  }

  async reconcile(): Promise<number> {
    const now = Date.now();
    const expiredLeases = await this.di.storage.list<PubSubDeliveryRecord>(
      NS_DELIVERIES,
      { topicName: this.name, status: "leased" },
      {
        limit: this.moduleConfig.reconciliationBatchSize ?? 500,
        where: [{ field: "leaseDeadline", op: "$lt", value: now }],
      },
    );
    const duePending = await this.di.storage.list<PubSubDeliveryRecord>(
      NS_DELIVERIES,
      { topicName: this.name, status: "pending" },
      {
        limit: this.moduleConfig.reconciliationBatchSize ?? 500,
        where: [{ field: "nextRunAt", op: "$lte", value: now }],
      },
    );

    let repaired = 0;
    for (const delivery of [...expiredLeases, ...duePending]) {
      delivery.status = "pending";
      delivery.consumerId = undefined;
      delivery.leasedAt = undefined;
      delivery.leaseDeadline = undefined;
      delivery.updatedAt = new Date();
      await this.di.storage.save(NS_DELIVERIES, delivery.id, delivery);
      await this.publishDelivery(delivery);
      repaired++;
    }
    if (repaired > 0) {
      OqronEventBus.emit("pubsub:reconciliation:repaired", this.name, repaired);
    }
    return repaired;
  }

  async cleanupRetention(): Promise<number> {
    const retention = this.topicConfig.retention;
    if (!retention?.maxAgeMs && !retention?.maxCount) return 0;

    let removed = 0;
    if (retention.maxAgeMs) {
      const cutoff = Date.now() - retention.maxAgeMs;
      const old = await this.di.storage.list<PubSubMessageRecord>(
        NS_MESSAGES,
        { topicName: this.name },
        {
          limit: 1000,
          where: [{ field: "publishedAt", op: "$lt", value: cutoff }],
        },
      );
      removed += await this.removeMessages(old);
    }

    if (retention.maxCount) {
      const all = await this.di.storage.list<PubSubMessageRecord>(
        NS_MESSAGES,
        { topicName: this.name },
        {
          limit: 100_000,
          orderBy: { field: "publishedAt", type: "number" },
        },
      );
      const excess = Math.max(0, all.length - retention.maxCount);
      if (excess > 0) {
        removed += await this.removeMessages(all.slice(0, excess));
      }
    }
    return removed;
  }

  private async pollSubscription(
    runtime: RuntimeSubscription<T>,
  ): Promise<void> {
    if (runtime.stopped) return;
    const group = await this.getGroup(runtime.config.group);
    if (!group || group.status === "paused") return;

    const concurrency =
      runtime.config.concurrency ?? this.moduleConfig.concurrency ?? 1;
    const maxInFlight = runtime.config.maxInFlight ?? concurrency;
    const freeSlots =
      Math.min(concurrency, maxInFlight) - runtime.inFlight.size;
    if (freeSlots <= 0) return;

    let claimed = 0;
    for (let partition = 0; partition < this.partitions; partition++) {
      if (claimed >= freeSlots) break;
      if (runtime.activePartitions.has(partition)) continue;
      const ids = await this.di.broker.claim(
        this.brokerName(runtime.config.group, partition),
        runtime.consumerId,
        1,
        this.lockTtlMs(runtime.config),
        "fifo",
      );
      for (const id of ids) {
        claimed++;
        runtime.inFlight.add(id);
        runtime.activePartitions.add(partition);
        void this.processDelivery(runtime, id, partition).finally(() => {
          runtime.inFlight.delete(id);
          runtime.activePartitions.delete(partition);
        });
      }
    }
  }

  private async processDelivery(
    runtime: RuntimeSubscription<T>,
    deliveryId: string,
    partition: number,
  ): Promise<void> {
    const brokerName = this.brokerName(runtime.config.group, partition);
    const delivery = await this.di.storage.get<PubSubDeliveryRecord>(
      NS_DELIVERIES,
      deliveryId,
    );
    if (!delivery || delivery.status === "acked") {
      await this.di.broker.ack(brokerName, deliveryId);
      return;
    }
    const message = await this.di.storage.get<PubSubMessageRecord>(
      NS_MESSAGES,
      delivery.messageId,
    );
    if (!message) {
      await this.markTerminal(delivery, "discarded");
      await this.di.broker.ack(brokerName, deliveryId);
      return;
    }

    const parsed = JSON.parse(message.payload) as T;
    if (runtime.config.filter && !runtime.config.filter(parsed)) {
      await this.markTerminal(delivery, "filtered");
      await this.di.broker.ack(brokerName, deliveryId);
      await this.advanceCursor(delivery.groupName, delivery.partition);
      return;
    }

    const attempt = delivery.attempt + 1;
    const leaseDeadline = Date.now() + this.lockTtlMs(runtime.config);
    delivery.status = "leased";
    delivery.consumerId = runtime.consumerId;
    delivery.leasedAt = Date.now();
    delivery.leaseDeadline = leaseDeadline;
    delivery.attempt = attempt;
    delivery.updatedAt = new Date();
    await this.di.storage.save(NS_DELIVERIES, delivery.id, delivery);
    OqronEventBus.emit("pubsub:delivery:claimed", this.name, delivery.id);

    const abortController = new AbortController();
    let settled = false;
    const heartbeat = this.startBrokerHeartbeat(
      brokerName,
      delivery.id,
      runtime.consumerId,
      this.lockTtlMs(runtime.config),
      abortController,
    );

    const settle = async (
      status: "ack" | "nack" | "discard",
      reason?: string,
    ): Promise<void> => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      if (status === "ack") {
        await this.ackDelivery(delivery, brokerName);
      } else if (status === "discard") {
        await this.discardDelivery(delivery, brokerName, reason);
      } else {
        await this.nackDelivery(delivery, brokerName, runtime.config, reason);
      }
    };

    const maxAttempts = this.maxAttempts(runtime.config);
    const ctx = this.createContext(
      runtime,
      message,
      parsed,
      attempt,
      maxAttempts,
      abortController,
      settle,
    );

    try {
      await this.runWithTimeout(runtime.config, ctx, abortController);
      if (runtime.config.ackMode !== "manual") {
        await settle("ack");
      } else if (!settled) {
        await settle("nack", "Manual ack was not called");
      }
    } catch (err) {
      if (runtime.config.ackMode !== "manual") {
        await settle("nack", err instanceof Error ? err.message : String(err));
      } else if (!settled) {
        await settle("nack", err instanceof Error ? err.message : String(err));
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async runWithTimeout(
    config: SubscriptionConfig<T>,
    ctx: MessageContext<T>,
    abortController: AbortController,
  ): Promise<void> {
    const timeoutMs =
      config.ackTimeoutMs ?? this.moduleConfig.ackTimeoutMs ?? 30_000;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        abortController.abort();
        reject(new Error(`PubSub message ${ctx.messageId} timed out`));
      }, timeoutMs);
      timeout.unref();
    });
    try {
      await Promise.race([config.handler(ctx), timeoutPromise]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private createContext(
    runtime: RuntimeSubscription<T>,
    message: PubSubMessageRecord,
    parsed: T,
    attempt: number,
    maxAttempts: number,
    abortController: AbortController,
    settle: (
      status: "ack" | "nack" | "discard",
      reason?: string,
    ) => Promise<void>,
  ): MessageContext<T> {
    const log = (level: "info" | "warn" | "error", msg: string) => {
      this.logger[level](
        `[pubsub:${this.name}:${runtime.config.group}] ${msg}`,
        {
          messageId: message.id,
        },
      );
    };

    return {
      messageId: message.id,
      message: parsed,
      topic: this.name,
      group: runtime.config.group,
      partition: message.partition,
      offset: message.offset,
      publishedAt: new Date(message.publishedAt),
      attempt,
      maxAttempts,
      headers: message.headers,
      signal: abortController.signal,
      get aborted() {
        return abortController.signal.aborted;
      },
      ack: () => settle("ack"),
      nack: (reason?: string) => settle("nack", reason),
      discard: (reason?: string) => settle("discard", reason),
      log: {
        info: (msg: string) => log("info", msg),
        warn: (msg: string) => log("warn", msg),
        error: (msg: string) => log("error", msg),
      },
    };
  }

  private startBrokerHeartbeat(
    brokerName: string,
    deliveryId: string,
    consumerId: string,
    lockTtlMs: number,
    abortController: AbortController,
  ): ReturnType<typeof setInterval> {
    const interval = setInterval(
      () => {
        void this.di.broker
          .extendLock(deliveryId, consumerId, lockTtlMs, brokerName)
          .catch(() => abortController.abort());
      },
      Math.max(100, Math.floor(lockTtlMs / 3)),
    );
    interval.unref();
    return interval;
  }

  private async ackDelivery(
    delivery: PubSubDeliveryRecord,
    brokerName: string,
  ): Promise<void> {
    await this.markTerminal(delivery, "acked");
    await this.di.broker.ack(brokerName, delivery.id);
    await this.advanceCursor(delivery.groupName, delivery.partition);
    await this.topicConfig.hooks?.onAck?.(
      delivery.messageId,
      delivery.groupName,
    );
    OqronEventBus.emit("pubsub:delivery:acked", this.name, delivery.id);
  }

  private async discardDelivery(
    delivery: PubSubDeliveryRecord,
    brokerName: string,
    reason?: string,
  ): Promise<void> {
    delivery.error = reason;
    await this.markTerminal(delivery, "discarded");
    await this.di.broker.ack(brokerName, delivery.id);
    await this.advanceCursor(delivery.groupName, delivery.partition);
  }

  private async nackDelivery(
    delivery: PubSubDeliveryRecord,
    brokerName: string,
    config: SubscriptionConfig<T>,
    reason?: string,
  ): Promise<void> {
    const maxAttempts = this.maxAttempts(config);
    if (delivery.attempt < maxAttempts) {
      const delayMs = this.retryDelay(config, delivery.attempt);
      delivery.status = "pending";
      delivery.consumerId = undefined;
      delivery.leasedAt = undefined;
      delivery.leaseDeadline = undefined;
      delivery.nextRunAt = Date.now() + delayMs;
      delivery.error = reason;
      delivery.updatedAt = new Date();
      await this.di.storage.save(NS_DELIVERIES, delivery.id, delivery);
      await this.di.broker.nack(brokerName, delivery.id, delayMs);
      OqronEventBus.emit("pubsub:delivery:nacked", this.name, delivery.id);
      return;
    }
    await this.deadLetterDelivery(delivery, brokerName, config, reason);
  }

  private async deadLetterDelivery(
    delivery: PubSubDeliveryRecord,
    brokerName: string,
    config: SubscriptionConfig<T>,
    reason?: string,
  ): Promise<void> {
    const message = await this.di.storage.get<PubSubMessageRecord>(
      NS_MESSAGES,
      delivery.messageId,
    );
    const error = reason ?? "PubSub delivery failed permanently";
    delivery.status = "dead";
    delivery.error = error;
    delivery.updatedAt = new Date();
    await this.di.storage.save(NS_DELIVERIES, delivery.id, delivery);
    if (
      (config.deadLetter?.enabled ?? this.moduleConfig.deadLetter?.enabled) &&
      message
    ) {
      const dead: PubSubDeadLetterRecord = {
        id: delivery.id,
        topicName: this.name,
        groupName: delivery.groupName,
        messageId: delivery.messageId,
        deliveryId: delivery.id,
        partition: delivery.partition,
        offset: delivery.offset,
        payload: message.payload,
        headers: message.headers,
        attempt: delivery.attempt,
        error,
        deadAt: Date.now(),
        createdAt: new Date(),
      };
      await this.di.storage.save(NS_DEAD, dead.id, dead);
      const parsed = JSON.parse(message.payload) as T;
      await config.deadLetter?.onDead?.(message.id, parsed, new Error(error));
      await this.topicConfig.hooks?.onDead?.(
        message.id,
        delivery.groupName,
        new Error(error),
      );
    }
    await this.di.broker.ack(brokerName, delivery.id);
    await this.advanceCursor(delivery.groupName, delivery.partition);
    OqronEventBus.emit("pubsub:delivery:dead", this.name, delivery.id);
  }

  private async markTerminal(
    delivery: PubSubDeliveryRecord,
    status: "acked" | "discarded" | "dead" | "filtered",
  ): Promise<void> {
    delivery.status = status;
    delivery.consumerId = undefined;
    delivery.leasedAt = undefined;
    delivery.leaseDeadline = undefined;
    delivery.nextRunAt = undefined;
    delivery.updatedAt = new Date();
    await this.di.storage.save(NS_DELIVERIES, delivery.id, delivery);
  }

  private async advanceCursor(
    groupName: string,
    partition: number,
  ): Promise<void> {
    const group = await this.getGroup(groupName);
    if (!group) return;
    let current = group.committedOffsets[String(partition)] ?? 0;
    while (true) {
      const next = await this.di.storage.list<PubSubDeliveryRecord>(
        NS_DELIVERIES,
        { topicName: this.name, groupName, partition, offset: current + 1 },
        { limit: 1 },
      );
      const delivery = next[0];
      if (!delivery || !terminalDeliveryStates.has(delivery.status)) break;
      current = delivery.offset;
    }
    group.committedOffsets[String(partition)] = current;
    group.updatedAt = new Date();
    await this.di.storage.save(NS_GROUPS, group.id, group);
  }

  private async createDeliveriesForMessage(
    message: PubSubMessageRecord,
  ): Promise<void> {
    const groups = await this.getGroups();
    for (const group of groups) {
      const committed = group.committedOffsets[String(message.partition)] ?? 0;
      if (message.offset <= committed) continue;
      const delivery = this.createDelivery(group.groupName, message);
      const inserted = await this.saveIfAbsent(
        NS_DELIVERIES,
        delivery.id,
        delivery,
      );
      if (inserted && group.status === "active") {
        await this.publishDelivery(delivery);
      }
    }
  }

  private async ensureDeliveriesForGroup(
    groupName: string,
    replay: boolean,
  ): Promise<void> {
    const group = await this.getGroup(groupName);
    if (!group) return;
    for (let partition = 0; partition < this.partitions; partition++) {
      const committed = group.committedOffsets[String(partition)] ?? 0;
      const messages = await this.di.storage.list<PubSubMessageRecord>(
        NS_MESSAGES,
        { topicName: this.name, partition },
        {
          limit: 100_000,
          where: [{ field: "offset", op: "$gt", value: committed }],
          orderBy: { field: "offset", direction: "asc", type: "number" },
        },
      );
      const toPublish: PubSubDeliveryRecord[] = [];
      for (const message of messages) {
        const delivery = this.createDelivery(groupName, message);
        if (replay) {
          await this.di.storage.save(NS_DELIVERIES, delivery.id, delivery);
          toPublish.push(delivery);
        } else {
          const inserted = await this.saveIfAbsent(
            NS_DELIVERIES,
            delivery.id,
            delivery,
          );
          if (inserted) toPublish.push(delivery);
        }
      }
      if (group.status === "active") {
        await this.publishDeliveries(groupName, partition, toPublish);
      }
    }
  }

  private createDelivery(
    groupName: string,
    message: PubSubMessageRecord,
  ): PubSubDeliveryRecord {
    const now = new Date();
    return {
      id: this.deliveryId(groupName, message.partition, message.offset),
      topicName: this.name,
      groupName,
      messageId: message.id,
      partition: message.partition,
      offset: message.offset,
      status: "pending",
      attempt: 0,
      nextRunAt: undefined,
      createdAt: now,
      updatedAt: now,
    };
  }

  private async publishDelivery(delivery: PubSubDeliveryRecord): Promise<void> {
    await this.di.broker.publish(
      this.brokerName(delivery.groupName, delivery.partition),
      delivery.id,
      delivery.nextRunAt
        ? Math.max(0, delivery.nextRunAt - Date.now())
        : undefined,
    );
  }

  private async publishDeliveries(
    groupName: string,
    partition: number,
    deliveries: PubSubDeliveryRecord[],
  ): Promise<void> {
    if (deliveries.length === 0) return;
    const brokerName = this.brokerName(groupName, partition);
    const items = deliveries.map((delivery) => ({
      id: delivery.id,
      delayMs: delivery.nextRunAt
        ? Math.max(0, delivery.nextRunAt - Date.now())
        : undefined,
    }));
    if (this.di.broker.publishBatch) {
      await this.di.broker.publishBatch(brokerName, items);
      return;
    }
    for (const item of items) {
      await this.di.broker.publish(brokerName, item.id, item.delayMs);
    }
  }

  private async ensureGroup(config: SubscriptionConfig<T>): Promise<void> {
    const id = this.groupId(config.group);
    const existing = await this.di.storage.get<PubSubGroupRecord>(
      NS_GROUPS,
      id,
    );
    if (existing) {
      existing.status = "active";
      existing.updatedAt = new Date();
      await this.di.storage.save(NS_GROUPS, id, existing);
      return;
    }
    const committedOffsets = await this.resolveInitialOffsets(config.startFrom);
    const now = new Date();
    const group: PubSubGroupRecord = {
      id,
      topicName: this.name,
      groupName: config.group,
      status: "active",
      startFrom: this.startFromLabel(config.startFrom),
      committedOffsets,
      createdAt: now,
      updatedAt: now,
    };
    await this.di.storage.save(NS_GROUPS, id, group);
  }

  private async resolveInitialOffsets(
    startFrom: SubscriptionConfig<T>["startFrom"],
  ): Promise<Record<string, number>> {
    if (startFrom === undefined || startFrom === "latest") {
      return this.getHeadOffsets();
    }
    if (startFrom === "earliest") {
      return this.emptyOffsets(0);
    }
    if (typeof startFrom === "number") {
      return this.emptyOffsets(Math.max(0, startFrom - 1));
    }
    return this.offsetsBeforeTimestamp(startFrom);
  }

  private async resolveSeekOffsets(
    opts: SeekOptions,
    existing: Record<string, number>,
  ): Promise<Record<string, number>> {
    if ("position" in opts) {
      return opts.position === "latest"
        ? this.getHeadOffsets()
        : this.emptyOffsets(0);
    }
    if ("offset" in opts) {
      return this.emptyOffsets(Math.max(0, opts.offset - 1));
    }
    if ("timestamp" in opts) {
      return this.offsetsBeforeTimestamp(opts.timestamp);
    }
    const message = await this.di.storage.get<PubSubMessageRecord>(
      NS_MESSAGES,
      opts.messageId,
    );
    if (!message || message.topicName !== this.name) return existing;
    return {
      ...existing,
      [String(message.partition)]: Math.max(0, message.offset - 1),
    };
  }

  private async offsetsBeforeTimestamp(
    timestamp: Date | number,
  ): Promise<Record<string, number>> {
    const cutoff = new Date(timestamp).getTime();
    const offsets = this.emptyOffsets(0);
    for (let partition = 0; partition < this.partitions; partition++) {
      const messages = await this.di.storage.list<PubSubMessageRecord>(
        NS_MESSAGES,
        { topicName: this.name, partition },
        {
          limit: 100_000,
          where: [{ field: "publishedAt", op: "$lt", value: cutoff }],
          orderBy: { field: "offset", direction: "desc", type: "number" },
        },
      );
      offsets[String(partition)] = messages[0]?.offset ?? 0;
    }
    return offsets;
  }

  private startFromLabel(
    startFrom: SubscriptionConfig<T>["startFrom"],
  ): "latest" | "earliest" | "custom" {
    if (startFrom === "earliest") return "earliest";
    if (startFrom === undefined || startFrom === "latest") return "latest";
    return "custom";
  }

  private async resolveExistingId(
    options: PubSubPublishOptions,
  ): Promise<string | null> {
    if (options.messageId) {
      const existing = await this.di.storage.get<PubSubMessageRecord>(
        NS_MESSAGES,
        options.messageId,
      );
      if (existing?.topicName === this.name) return existing.id;
    }
    if (options.idempotencyKey) {
      const existing = await this.di.storage.get<{ messageId: string }>(
        NS_IDEMPOTENCY,
        this.idempotencyKey(options),
      );
      if (existing?.messageId) return existing.messageId;
    }
    return null;
  }

  private resolvePartition(message: T, options: PubSubPublishOptions): number {
    const key =
      options.partitionKey ??
      this.topicConfig.distribution?.partitionKey?.(message, options);
    if (key === undefined || key === null) return 0;
    const digest = createHash("sha1").update(String(key)).digest();
    return digest.readUInt32BE(0) % this.partitions;
  }

  private async incrementOffset(partition: number): Promise<number> {
    if (!this.di.storage.increment) {
      const current = await this.getHeadOffset(partition);
      const next = current + 1;
      await this.di.storage.save(NS_OFFSETS, this.offsetId(partition), {
        offset: next,
      });
      return next;
    }
    return this.di.storage.increment(
      NS_OFFSETS,
      this.offsetId(partition),
      "offset",
      1,
    );
  }

  private async getHeadOffsets(): Promise<Record<string, number>> {
    const offsets: Record<string, number> = {};
    for (let partition = 0; partition < this.partitions; partition++) {
      offsets[String(partition)] = await this.getHeadOffset(partition);
    }
    return offsets;
  }

  private async getHeadOffset(partition: number): Promise<number> {
    const record = await this.di.storage.get<{ offset?: number }>(
      NS_OFFSETS,
      this.offsetId(partition),
    );
    return Number(record?.offset ?? 0);
  }

  private emptyOffsets(value: number): Record<string, number> {
    const offsets: Record<string, number> = {};
    for (let partition = 0; partition < this.partitions; partition++) {
      offsets[String(partition)] = value;
    }
    return offsets;
  }

  private async getGroup(groupName: string): Promise<PubSubGroupRecord | null> {
    return this.di.storage.get<PubSubGroupRecord>(
      NS_GROUPS,
      this.groupId(groupName),
    );
  }

  private async getGroups(): Promise<PubSubGroupRecord[]> {
    return this.di.storage.list<PubSubGroupRecord>(
      NS_GROUPS,
      { topicName: this.name },
      { limit: 100_000 },
    );
  }

  private maxAttempts(config: SubscriptionConfig<T>): number {
    return (config.retries?.max ?? this.moduleConfig.retries?.max ?? 0) + 1;
  }

  private retryDelay(config: SubscriptionConfig<T>, attempt: number): number {
    const strategy =
      config.retries?.strategy ??
      this.moduleConfig.retries?.strategy ??
      "exponential";
    const baseDelay =
      config.retries?.baseDelay ??
      this.moduleConfig.retries?.baseDelay ??
      1_000;
    const maxDelay =
      config.retries?.maxDelay ?? this.moduleConfig.retries?.maxDelay ?? 60_000;
    return calculateBackoff(
      { type: strategy, delay: baseDelay },
      attempt,
      maxDelay,
    );
  }

  private lockTtlMs(config: SubscriptionConfig<T>): number {
    return config.ackTimeoutMs ?? this.moduleConfig.lockTtlMs ?? 30_000;
  }

  private brokerName(groupName: string, partition: number): string {
    return `pubsub:${this.name}:${groupName}:p:${partition}`;
  }

  private groupId(groupName: string): string {
    return `${this.name}:${groupName}`;
  }

  private offsetId(partition: number): string {
    return `${this.name}:p:${partition}`;
  }

  private deliveryId(
    groupName: string,
    partition: number,
    offset: number,
  ): string {
    return `${this.name}:${groupName}:p:${partition}:o:${offset}`;
  }

  private idempotencyKey(options: PubSubPublishOptions): string {
    return `${this.name}:${options.idempotencyKey}`;
  }

  private async saveIfAbsent<R>(
    namespace: string,
    id: string,
    data: R,
  ): Promise<boolean> {
    if (this.di.storage.saveIfAbsent) {
      return this.di.storage.saveIfAbsent(namespace, id, data);
    }
    const existing = await this.di.storage.get(namespace, id);
    if (existing) return false;
    await this.di.storage.save(namespace, id, data);
    return true;
  }

  private async bulkDelete(namespace: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    if (this.di.storage.bulkDelete) {
      await this.di.storage.bulkDelete(namespace, ids);
      return;
    }
    for (const id of ids) {
      await this.di.storage.delete(namespace, id);
    }
  }

  private async removeMessages(
    messages: PubSubMessageRecord[],
  ): Promise<number> {
    await this.bulkDelete(
      NS_MESSAGES,
      messages.map((message) => message.id),
    );
    return messages.length;
  }
}
