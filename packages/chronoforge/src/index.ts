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

export const ChronoForge = {
  /**
   * Initialize ChronoForge: loads config, assigns adapters, and boots modules.
   *
   * @param opts.cwd       - Working directory for config file lookup (default: process.cwd())
   * @param opts.db        - Pre-built IChronoAdapter (overrides config)
   * @param opts.lock      - Pre-built ILockAdapter (overrides config)
   * @param opts.schedules - Array of CronDefinitions to register with the scheduler
   */
  async init(opts?: {
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

    // --- Assign adapters straight from config (or opts override) ---
    _db = opts?.db ?? _config.db;
    _lock = opts?.lock ?? _config.lock;

    // --- Register the scheduler module if requested ---
    if (
      _config.modules.includes("cron") &&
      opts?.schedules &&
      opts.schedules.length > 0
    ) {
      // Dynamic import to avoid strict dependency on scheduler if not used
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
  },

  /** Gracefully stop all modules */
  async stop(): Promise<void> {
    const log =
      _logger ?? createLogger({ level: "info", module: "chronoforge" });
    log.info("Stopping ChronoForge…");
    const registry = ChronoRegistry.getInstance();
    for (const mod of registry.getAll()) {
      if (mod.enabled) await mod.stop();
    }
    log.info("ChronoForge stopped.");
  },

  /** Get the current validated config */
  getConfig(): ValidatedConfig {
    if (!_config)
      throw new Error(
        "[ChronoForge] Not initialized yet. Call ChronoForge.init() first.",
      );
    return _config;
  },

  /** Get the database adapter (available after init()) */
  getDb(): IChronoAdapter {
    if (!_db) throw new Error("[ChronoForge] Not initialized yet.");
    return _db;
  },

  /** Get the lock adapter (available after init()) */
  getLock(): ILockAdapter {
    if (!_lock) throw new Error("[ChronoForge] Not initialized yet.");
    return _lock;
  },
};
