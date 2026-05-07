export type PubSubStartPosition = "latest" | "earliest" | Date | number;

export type PubSubAckMode = "auto" | "manual";

export type PubSubDeliveryStatus =
  | "pending"
  | "leased"
  | "acked"
  | "nacked"
  | "discarded"
  | "dead"
  | "filtered";

export interface PubSubPublishOptions {
  messageId?: string;
  idempotencyKey?: string;
  partitionKey?: string;
  headers?: Record<string, string>;
  delayMs?: number;
  expiresAt?: Date | number;
  correlationId?: string;
}

export interface TopicDistributionConfig<T = any> {
  partitions?: number;
  strategy?: "hash";
  partitionKey?: (message: T, meta: PubSubPublishOptions) => string | number;
}

export interface TopicConfig<T = any> {
  name: string;
  retention?: {
    maxAgeMs?: number;
    maxCount?: number;
  };
  validate?: (message: T) => boolean | string;
  distribution?: TopicDistributionConfig<T>;
  tags?: string[];
  hooks?: {
    onPublish?: (
      message: T,
      messageId: string,
      meta: PubSubPublishOptions,
    ) => void | Promise<void>;
    onAck?: (messageId: string, group: string) => void | Promise<void>;
    onDead?: (
      messageId: string,
      group: string,
      error: Error,
    ) => void | Promise<void>;
  };
}

export interface SubscriptionConfig<T = any> {
  group: string;
  concurrency?: number;
  handler: (ctx: MessageContext<T>) => Promise<void>;
  filter?: (message: T) => boolean;
  startFrom?: PubSubStartPosition;
  retries?: {
    max?: number;
    strategy?: "fixed" | "exponential";
    baseDelay?: number;
    maxDelay?: number;
  };
  deadLetter?: {
    enabled?: boolean;
    onDead?: (
      messageId: string,
      message: T,
      error: Error,
    ) => void | Promise<void>;
  };
  ackTimeoutMs?: number;
  batchSize?: number;
  maxInFlight?: number;
  ackMode?: PubSubAckMode;
}

export interface MessageContext<T = any> {
  readonly messageId: string;
  readonly message: T;
  readonly topic: string;
  readonly group: string;
  readonly partition: number;
  readonly offset: number;
  readonly publishedAt: Date;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly headers: Record<string, string>;
  readonly signal: AbortSignal;
  readonly aborted: boolean;
  ack(): Promise<void>;
  nack(reason?: string): Promise<void>;
  discard(reason?: string): Promise<void>;
  log: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  };
}

export interface PubSubMessageRecord {
  id: string;
  topicName: string;
  partition: number;
  offset: number;
  payload: string;
  headers: Record<string, string>;
  idempotencyKey?: string;
  correlationId?: string;
  publishedAt: number;
  expiresAt: number | null;
  sizeBytes: number;
  project: string;
  environment: string;
  createdAt: Date;
}

export interface PubSubGroupRecord {
  id: string;
  topicName: string;
  groupName: string;
  status: "active" | "paused";
  startFrom: "latest" | "earliest" | "custom";
  committedOffsets: Record<string, number>;
  createdAt: Date;
  updatedAt: Date;
}

export interface PubSubDeliveryRecord {
  id: string;
  topicName: string;
  groupName: string;
  messageId: string;
  partition: number;
  offset: number;
  status: PubSubDeliveryStatus;
  consumerId?: string;
  leasedAt?: number;
  leaseDeadline?: number;
  attempt: number;
  nextRunAt?: number;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface PubSubDeadLetterRecord {
  id: string;
  topicName: string;
  groupName: string;
  messageId: string;
  deliveryId: string;
  partition: number;
  offset: number;
  payload: string;
  headers: Record<string, string>;
  attempt: number;
  error: string;
  deadAt: number;
  createdAt: Date;
}

export interface TopicStats {
  name: string;
  partitions: number;
  messageCount: number;
  oldestMessageAt: number | null;
  newestMessageAt: number | null;
  groups: Array<{
    name: string;
    lag: number;
    activeConsumers: number;
    pendingMessages: number;
    deadLetterCount: number;
    committedOffsets: Record<string, number>;
  }>;
}

export interface ITopic<T = any> {
  readonly name: string;
  publish(message: T, options?: PubSubPublishOptions): Promise<string>;
  publishBatch(
    messages: Array<{ message: T; options?: PubSubPublishOptions }>,
  ): Promise<string[]>;
  subscribe(config: SubscriptionConfig<T>): Promise<() => Promise<void>>;
  replay(opts: { group: string; from: Date | number }): Promise<void>;
  seek(
    group: string,
    opts:
      | { position: "earliest" | "latest" }
      | { offset: number }
      | { timestamp: Date | number }
      | { messageId: string },
  ): Promise<void>;
  stats(): Promise<TopicStats>;
  lag(group?: string): Promise<number>;
  purge(): Promise<number>;
  pause(group?: string): Promise<void>;
  resume(group?: string): Promise<void>;
  deadLetters(
    group: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<PubSubDeadLetterRecord[]>;
  retryDeadLetter(group: string, messageId: string): Promise<void>;
  retryAllDeadLetters(group: string): Promise<number>;
}
