import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ChronoRegistry,
  createLogger,
  type IChronoAdapter,
  type ILockAdapter,
  type Logger,
  loadConfig,
  type ValidatedConfig,
} from "./core/index.js";

let _config: ValidatedConfig | null = null;
let _db: IChronoAdapter | null = null;
let _lock: ILockAdapter | null = null;
let _logger: Logger | null = null;

export type {
  ChronoLoggerConfig,
  CronDefinition,
  CronHooks,
  EveryConfig,
  IChronoAdapter,
  ICronContext,
  ILockAdapter,
  JobRecord,
  Logger,
  MissedFirePolicy,
  OverlapPolicy,
} from "./core/index.js";
// ── Re-exports: single source of truth for ALL user-facing APIs ─────────────
export { ChronoEventBus, createLogger, defineConfig } from "./core/index.js";
export { SqliteAdapter } from "./db/index.js";
export { DbLockAdapter, MemoryLockAdapter } from "./lock/index.js";
export { cron, type DefineCronOptions } from "./scheduler/index.js";

export const ChronoForge = {
  /**
   * Initialize ChronoForge: loads config, auto-discovers jobs, and boots modules.
   *
   * @param opts.cwd - Working directory for config file lookup and jobsDir resolution
   */
  async init(opts?: { cwd?: string }): Promise<void> {
    const cwd = opts?.cwd ?? process.cwd();
    _config = await loadConfig(cwd);

    const loggerConfig =
      _config.logger === false ? { enabled: false } : _config.logger;
    _logger = createLogger(loggerConfig, { module: "chronoforge" });

    _logger.info(
      `Starting ChronoForge in "${_config.environment}" environment`,
    );

    // --- Assign adapters straight from config ---
    _db = _config.db;
    _lock = _config.lock;

    // --- Boot modules ---
    if (_config.modules.includes("cron")) {
      const { SchedulerModule, _drainPending } = await import(
        "./scheduler/index.js"
      );

      // Auto-discover jobs if directory is configured
      if (_config.jobsDir) {
        const jobsPath = path.resolve(cwd, _config.jobsDir);
        _logger.debug(`Scanning jobsDir: ${jobsPath}`);

        try {
          async function scan(dir: string) {
            try {
              const entries = await fs.readdir(dir, { withFileTypes: true });
              for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                  await scan(fullPath);
                } else if (
                  entry.isFile() &&
                  /\.(js|ts|mjs|cjs)$/.test(entry.name) &&
                  !entry.name.endsWith(".d.ts")
                ) {
                  _logger?.debug(`Auto-importing job file: ${entry.name}`);
                  // Dynamically import to trigger cron() side-effects
                  await import(pathToFileURL(fullPath).toString());
                }
              }
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
            }
          }

          await scan(jobsPath);
        } catch (err) {
          _logger.warn(`Failed to scan jobsDir: ${_config.jobsDir}`, {
            error: String(err),
          });
        }
      }

      // Collect all auto-registered definitions
      const schedules = _drainPending();

      const scheduler = new SchedulerModule(schedules, _db!, _lock!, _logger!);
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
      _logger ??
      createLogger({ enabled: true, level: "info" }, { module: "chronoforge" });
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

  /** Get the Express router for monitoring */
  expressRouter() {
    return require("./server/express.js").expressRouter();
  },

  /** Get the Fastify plugin for monitoring */
  fastifyPlugin(fastify: any, opts: any, done: () => void) {
    return require("./server/fastify.js").fastifyPlugin(fastify, opts, done);
  },
};

export default ChronoForge;
