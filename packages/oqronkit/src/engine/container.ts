import type { OqronConfig } from "./types/config.types.js";
import type {
  IBrokerEngine,
  ILockAdapter,
  IStorageEngine,
} from "./types/engine.js";

const makeIsolatedStorage = (
  base: IStorageEngine,
  prefix: string,
): IStorageEngine => ({
  save: (ns, id, data) => base.save(`${prefix}:${ns}`, id, data),
  get: (ns, id) => base.get(`${prefix}:${ns}`, id),
  list: (ns, filter, opts) => base.list(`${prefix}:${ns}`, filter, opts),
  delete: (ns, id) => base.delete(`${prefix}:${ns}`, id),
  prune: (ns, before) => base.prune(`${prefix}:${ns}`, before),
  count: (ns, filter) => base.count(`${prefix}:${ns}`, filter),
});

const makeIsolatedBroker = (
  base: IBrokerEngine,
  prefix: string,
): IBrokerEngine => ({
  publish: (ns, id, delay, prio) =>
    base.publish(`${prefix}:${ns}`, id, delay, prio),
  claim: (ns, cid, limit, ttl, strat) =>
    base.claim(`${prefix}:${ns}`, cid, limit, ttl, strat),
  ack: (ns, id) => base.ack(`${prefix}:${ns}`, id),
  nack: (ns, id, delay) => base.nack(`${prefix}:${ns}`, id, delay),
  extendLock: (id, cid, ttl) => base.extendLock(id, cid, ttl),
  pause: (ns) => base.pause(`${prefix}:${ns}`),
  resume: (ns) => base.resume(`${prefix}:${ns}`),
});

const makeIsolatedLock = (base: ILockAdapter, prefix: string): ILockAdapter => ({
  acquire: (key, owner, ttl) => base.acquire(`${prefix}:${key}`, owner, ttl),
  renew: (key, owner, ttl) => base.renew(`${prefix}:${key}`, owner, ttl),
  release: (key, owner) => base.release(`${prefix}:${key}`, owner),
  isOwner: (key, owner) => base.isOwner(`${prefix}:${key}`, owner),
});

/**
 * OqronContainer — Dependency Injection container for OqronKit adapters.
 *
 * Replaces mutable module globals with a centralized, testable, multi-instance-ready
 * container. The static `get()` accessor provides backward compatibility for code
 * that previously imported `Storage`, `Broker`, `Lock` as bare globals.
 *
 * For multi-instance setups:
 * ```ts
 * const container = new OqronContainer(store, broker, lock);
 * const engine = new QueueEngine(config, logger, container);
 * ```
 *
 * For monolith / default:
 * ```ts
 * OqronContainer.init(store, broker, lock);
 * // all engines auto-resolve via OqronContainer.get()
 * ```
 */
export class OqronContainer {
  private static _instance: OqronContainer | null = null;

  constructor(
    public readonly storage: IStorageEngine,
    public readonly broker: IBrokerEngine,
    public readonly lock: ILockAdapter,
    private readonly _config?: OqronConfig,
  ) {}

  /** Access the resolved config (environment, project, etc.) */
  get config(): OqronConfig | undefined {
    return this._config;
  }

  /**
   * Initialize the global singleton container.
   * Called by `initEngine()` during bootstrap.
   */
  static init(
    storage: IStorageEngine,
    broker: IBrokerEngine,
    lock: ILockAdapter,
    config?: OqronConfig,
  ): OqronContainer {
    const envStr = config?.environment ?? "default";
    const projStr = config?.project ?? "default";
    const isolationPrefix = `oqron:${projStr}:${envStr}`;

    OqronContainer._instance = new OqronContainer(
      makeIsolatedStorage(storage, isolationPrefix),
      makeIsolatedBroker(broker, isolationPrefix),
      makeIsolatedLock(lock, isolationPrefix),
      config,
    );
    return OqronContainer._instance;
  }

  /**
   * Retrieve the global container. Throws if not initialized.
   */
  static get(): OqronContainer {
    if (!OqronContainer._instance) {
      throw new Error(
        "[OqronKit] Container not initialized. Call OqronKit.init() or initEngine() first.",
      );
    }
    return OqronContainer._instance;
  }

  /**
   * Returns the global container, or `null` if not initialized.
   * Useful for conditional access (e.g., in tests).
   */
  static tryGet(): OqronContainer | null {
    return OqronContainer._instance;
  }

  /** Reset — for testing and shutdown. */
  static reset(): void {
    OqronContainer._instance = null;
  }
}
