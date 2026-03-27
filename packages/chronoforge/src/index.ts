import {
  type ChronoLogger,
  ChronoRegistry,
  createLogger,
  type IChronoAdapter,
  type ILockAdapter,
  loadConfig,
  type ValidatedConfig,
} from "@chronoforge/core";

let _config: ValidatedConfig | null = null;
let _db: IChronoAdapter | null = null;
let _lock: ILockAdapter | null = null;
let _logger: ChronoLogger | null = null;

export { defineConfig } from "@chronoforge/core";
export { cron, type DefineCronOptions } from "@chronoforge/scheduler";

export class ChronoForge {
  /**
   * Initialize ChronoForge: loads config, creates adapters, boots all registered modules.
   *
   * @param opts.cwd       - Working directory for config file lookup (default: process.cwd())
   * @param opts.db        - Pre-built IChronoAdapter (overrides config)
   * @param opts.lock      - Pre-built ILockAdapter (overrides config)
   * @param opts.schedules - Array of CronDefinitions to register with the scheduler
   */
  static async init(opts?: {
    cwd?: string;
    db?: IChronoAdapter;
    lock?: ILockAdapter;
    schedules?: import("@chronoforge/core").CronDefinition[];
  }): Promise<void> {
    _config = await loadConfig(opts?.cwd);
    _logger = createLogger({
      level: _config.logger.level,
      module: "chronoforge",
    });

    _logger.info(
      `Starting ChronoForge in "${_config.environment}" environment`,
    );

    // --- Create adapters from config (or use pre-built ones) ---
    if (opts?.db) {
      _db = opts.db;
    } else {
      // Dynamic import — only loads better-sqlite3 if actually needed
      const { SqliteAdapter } = await import("@chronoforge/db");
      const dbPath = _config.db.url ?? "chrono.sqlite";
      _db = new SqliteAdapter(dbPath);
    }

    if (opts?.lock) {
      _lock = opts.lock;
    } else if (_config.lock.type === "db") {
      const { DbLockAdapter } = await import("@chronoforge/lock");
      const lockDbPath = _config.db.url ?? "chrono.sqlite";
      _lock = new DbLockAdapter(lockDbPath);
    } else {
      // Fallback to in-memory lock for dev
      const { MemoryLockAdapter } = await import("@chronoforge/lock");
      _lock = new MemoryLockAdapter();
    }

    // --- Register the scheduler module if schedules are provided ---
    if (opts?.schedules && opts.schedules.length > 0) {
      const { SchedulerModule } = await import("@chronoforge/scheduler");
      const scheduler = new SchedulerModule(
        opts.schedules,
        _db,
        _lock,
        _logger,
      );
      ChronoRegistry.getInstance().register(scheduler);
    }

    // --- Boot all registered modules ---
    const registry = ChronoRegistry.getInstance();
    const modules = registry.getAll();

    for (const mod of modules) {
      if (mod.enabled) {
        _logger.debug(`init() → ${mod.name}`);
        await mod.init();
      }
    }
    for (const mod of modules) {
      if (mod.enabled) {
        _logger.info(`start() → ${mod.name}`);
        await mod.start();
      }
    }

    _logger.info("ChronoForge ready ✓");
  }

  /** Gracefully stop all modules */
  static async stop(): Promise<void> {
    const log =
      _logger ?? createLogger({ level: "info", module: "chronoforge" });
    log.info("Stopping ChronoForge…");
    const registry = ChronoRegistry.getInstance();
    for (const mod of registry.getAll()) {
      if (mod.enabled) await mod.stop();
    }
    log.info("ChronoForge stopped.");
  }

  /** Get the current validated config */
  static getConfig(): ValidatedConfig {
    if (!_config)
      throw new Error(
        "[ChronoForge] Not initialized yet. Call ChronoForge.init() first.",
      );
    return _config;
  }

  /** Get the database adapter (available after init()) */
  static getDb(): IChronoAdapter {
    if (!_db) throw new Error("[ChronoForge] Not initialized yet.");
    return _db;
  }

  /** Get the lock adapter (available after init()) */
  static getLock(): ILockAdapter {
    if (!_lock) throw new Error("[ChronoForge] Not initialized yet.");
    return _lock;
  }
}
