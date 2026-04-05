import type { DisabledBehavior } from "../engine/types/config.types.js";
import type {
  OqronJob,
  OqronJobOptions,
  RemoveOnConfig,
} from "../engine/types/job.types.js";

export type WebhookMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface WebhookEndpoint {
  /** Target endpoint name */
  name: string;
  /** Destination URL. Can be a static string or a function of the payload. */
  url: string | ((data: any) => string | Promise<string>);
  /** Events this endpoint should listen to (supports glob like order.*) */
  events: string[];
  /** Optional override for method */
  method?: WebhookMethod;
  /** Optional static headers or a function to generate headers */
  headers?: Record<string, string> | ((data: any) => Record<string, string>);
  /** Optional override for security settings */
  security?: WebhookSecurityInput;
  /** Optional override for retries */
  retries?: WebhookRetryConfig;
  /** Optional disable flag (managed via DB at runtime too) */
  enabled?: boolean;
}

/** Endpoints can be a static array or a function that resolves them dynamically */
export type WebhookEndpointsInput =
  | WebhookEndpoint[]
  | (() => WebhookEndpoint[] | Promise<WebhookEndpoint[]>);

export interface WebhookSecurity {
  /** Secret used for HMAC signing of the payload */
  signingSecret: string;
  /** HMAC algorithm. @default "sha256" */
  signingAlgorithm?: "sha256" | "sha512";
  /** Header name for the signature. @default "X-Oqron-Signature" */
  signingHeader?: string;
  /** Include timestamp in signature for replay protection. @default true */
  includeTimestamp?: boolean;
  /** Timestamp header name. @default "X-Oqron-Timestamp" */
  timestampHeader?: string;
  /** Custom sign function. Replaces built-in HMAC signing. */
  signFunction?: (
    body: string,
    secret: string,
    timestamp: number,
  ) => string | Promise<string>;
}

/** Security can be a static object or a function that resolves it dynamically */
export type WebhookSecurityInput =
  | WebhookSecurity
  | (() => WebhookSecurity | Promise<WebhookSecurity>);

export interface WebhookRetryConfig {
  max?: number;
  strategy?: "fixed" | "exponential";
  baseDelay?: number;
  maxDelay?: number;
  retryOnStatus?: number[];
}

export interface WebhookDeliveryResult {
  status: number;
  headers: Record<string, string>;
  body: string | null;
  durationMs: number;
}

export interface WebhookDeliveryPayload<T = any> {
  event: string;
  endpointName: string;
  dispatcherName: string;
  url: string;
  method: WebhookMethod;
  headers: Record<string, string>;
  body: T;
  transformedBody?: any;
  security?: WebhookSecurity;
  idempotencyKey: string;
  timestamp: number;
}

export interface WebhookConfig<T = any> {
  /** Unique name for this webhook dispatcher */
  name: string;

  /** Endpoint definitions */
  endpoints: WebhookEndpointsInput;

  /** Default HTTP method. @default "POST" */
  method?: WebhookMethod;
  /** Default headers applied to all deliveries */
  headers?: Record<string, string>;
  /** HTTP request timeout in ms. @default 30000 */
  timeout?: number;
  /** Parallel delivery limit. @default 10 */
  concurrency?: number;

  /** Global security config */
  security?: WebhookSecurityInput;

  /** Default retry config */
  retries?: WebhookRetryConfig;

  /** Dead Letter Queue — matches queue module pattern */
  deadLetter?: {
    enabled?: boolean;
    onDead?: (job: OqronJob<WebhookDeliveryPayload<T>>) => Promise<void>;
  };

  /** Module isolation (same as queue) */
  disabledBehavior?: DisabledBehavior;
  removeOnComplete?: RemoveOnConfig;
  removeOnFail?: RemoveOnConfig;

  /** Transform payload before sending (applied to all endpoints) */
  transform?: (data: T, endpoint: WebhookEndpoint) => any;

  /** Lifecycle hooks - matching queue hooks for consistency */
  hooks?: {
    onSuccess?: (
      job: OqronJob<WebhookDeliveryPayload<T>>,
      result: WebhookDeliveryResult,
    ) => Promise<void> | void;
    onFail?: (
      job: OqronJob<WebhookDeliveryPayload<T>>,
      error: Error,
    ) => Promise<void> | void;
  };
}

export interface IWebhookDispatcher<T = any> {
  readonly name: string;

  /**
   * Fire an event to all matching endpoints.
   */
  fire(
    event: string,
    data: T,
    opts?: OqronJobOptions,
  ): Promise<OqronJob<WebhookDeliveryPayload<T>>[]>;

  /**
   * Fire to a specific endpoint only.
   */
  fireToEndpoint(
    endpointName: string,
    data: T,
    opts?: OqronJobOptions,
  ): Promise<OqronJob<WebhookDeliveryPayload<T>>>;

  // ── Endpoint Registry (DB-persisted) ──────────────────────
  getEndpoints(): Promise<WebhookEndpoint[]>;
  getEndpoint(name: string): Promise<WebhookEndpoint | undefined>;
  addEndpoint(endpoint: WebhookEndpoint): Promise<void>;
  removeEndpoint(name: string): Promise<boolean>;
  enableEndpoint(name: string): Promise<boolean>;
  disableEndpoint(name: string): Promise<boolean>;
}
