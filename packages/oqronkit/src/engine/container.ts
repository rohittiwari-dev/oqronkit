import type {
  IBrokerEngine,
  ILockAdapter,
  IStorageEngine,
} from "./types/engine.js";

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
 * const engine = new TaskQueueEngine(config, logger, container);
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
  ) {}

  /**
   * Initialize the global singleton container.
   * Called by `initEngine()` during bootstrap.
   */
  static init(
    storage: IStorageEngine,
    broker: IBrokerEngine,
    lock: ILockAdapter,
  ): OqronContainer {
    OqronContainer._instance = new OqronContainer(storage, broker, lock);
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
