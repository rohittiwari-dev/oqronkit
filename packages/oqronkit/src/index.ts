import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createLogger,
  type ILockAdapter,
  type IOqronAdapter,
  type Logger,
  loadConfig,
  type OqronConfig,
  OqronRegistry,
  reconfigureConfig,
  type ValidatedConfig,
} from "./core/index.js";
import {
  MemoryOqronAdapter,
  NamespacedOqronAdapter,
  PostgresAdapter,
  SqliteAdapter,
} from "./db/index.js";
import {
  DbLockAdapter,
  MemoryLockAdapter,
  NamespacedLockAdapter,
  PostgresLockAdapter,
} from "./lock/index.js";
import { expressRouter } from "./server/express.js";
import { fastifyPlugin } from "./server/fastify.js";
import { TelemetryManager } from "./telemetry/index.js";

let _config: ValidatedConfig | null = null;
let _db: IOqronAdapter | null = null;
let _lock: ILockAdapter | null = null;
let _logger: Logger | null = null;
let _telemetry: TelemetryManager | null = null;

export type {
  CronDefinition,
  CronHooks,
  EveryConfig,
  ICronContext,
  ILockAdapter,
  IOqronAdapter,
  IScheduleContext,
  JobRecord,
  Logger,
  MissedFirePolicy,
  OqronLoggerConfig,
  OverlapPolicy,
  RetryConfig,
  ScheduleDefinition,
  ScheduleHooks,
  ScheduleRecurring,
  ScheduleRunAfter,
} from "./core/index.js";
// ── Re-exports: single source of truth for ALL user-facing APIs ─────────────
export { createLogger, defineConfig, OqronEventBus } from "./core/index.js";
export { PostgresAdapter, SqliteAdapter } from "./db/index.js";
export {
  DbLockAdapter,
  MemoryLockAdapter,
  PostgresLockAdapter,
} from "./lock/index.js";
export {
  cron,
  type DefineCronOptions,
  type DefineScheduleOptions,
  type ScheduleInstance,
  schedule,
} from "./scheduler/index.js";

export const OqronKit = {
  /**
   * Initialize OqronKit: loads config, auto-discovers jobs, and boots modules.
   *
   * @param opts.cwd - Working directory for config file lookup and jobsDir resolution
   * @param opts.config - Explicit config object (skips loadConfig)
   */
  async init(opts?: { cwd?: string; config?: OqronConfig }): Promise<void> {
    const cwd = opts?.cwd ?? process.cwd();
    _config = reconfigureConfig(opts?.config ?? (await loadConfig(cwd)));

    const loggerConfig =
      _config.logger === false ? { enabled: true } : _config.logger;

    _logger = createLogger(loggerConfig, { module: "oqronkit" });

    _logger.info(`Starting OqronKit in "${_config.environment}" environment`);

    // --- Infrastructure Resolution ---
    if (!_config.db) {
      const msg =
        "No 'db' adapter configured. Falling back to ephemeral 'MemoryOqronAdapter'. [WARNING: Data will not persist across restarts]";
      if (_config.environment === "production") {
        _logger.fatal(`STERN WARNING: ${msg}`);
      } else {
        _logger.warn(msg);
      }
      _db = new MemoryOqronAdapter();
    } else if ("adapter" in _config.db) {
      const { adapter, url } = _config.db;
      if (adapter === "sqlite") {
        try {
          _db = new SqliteAdapter(url ?? "oqron.sqlite");
        } catch (err: any) {
          if (
            err.code === "ERR_MODULE_NOT_FOUND" ||
            err.code === "MODULE_NOT_FOUND" ||
            err.message?.includes("better-sqlite3")
          ) {
            throw new Error(
              "[OqronKit] SQLite adapter requires the 'better-sqlite3' package. Install it: npm install better-sqlite3",
            );
          }
          throw err;
        }
      } else if (adapter === "postgres") {
        if (!url) {
          throw new Error(
            "[OqronKit] PostgreSQL adapter requires a 'url' (connection string). Example: postgresql://user:pass@host:5432/db",
          );
        }
        // Dynamically import pg to keep it as a peer dependency
        try {
          // Dynamic import with variable to bypass TS module resolution for optional peer dep
          const pgModule = "pg";
          const pg = await (import(
            /* webpackIgnore: true */ pgModule
          ) as Promise<any>);
          const Pool = pg.default?.Pool ?? pg.Pool;
          const pool = new Pool({ connectionString: url });
          _db = new PostgresAdapter(pool);
          await (_db as PostgresAdapter).migrate();
          _logger.info("PostgreSQL adapter initialized successfully");
        } catch (err: any) {
          if (
            err.code === "ERR_MODULE_NOT_FOUND" ||
            err.code === "MODULE_NOT_FOUND"
          ) {
            throw new Error(
              "[OqronKit] PostgreSQL adapter requires the 'pg' package. Install it: npm install pg",
            );
          }
          throw err;
        }
      } else if (adapter === "memory") {
        const msg =
          "Using ephemeral 'memory' database adapter. [WARNING: Data will not persist across restarts]";
        if (_config.environment === "production") {
          _logger.fatal(`STERN WARNING: ${msg}`);
        } else {
          _logger.warn(msg);
        }
        _db = new MemoryOqronAdapter();
      } else {
        throw new Error(
          `[OqronKit] Database adapter '${adapter}' not yet bundled. Please pass a custom IOqronAdapter instance.`,
        );
      }
    } else {
      _db = _config.db as IOqronAdapter;
    }

    if (!_config.lock) {
      _logger.warn(
        "No 'lock' adapter configured. Falling back to ephemeral 'MemoryLockAdapter'.",
      );
      _lock = new MemoryLockAdapter();
    } else if ("adapter" in _config.lock) {
      const { adapter, url, ttl } = _config.lock;
      if (adapter === "db") {
        // Share the same DB if possible
        if (_db instanceof SqliteAdapter) {
          _lock = new DbLockAdapter((_db as any).db, ttl);
        } else if (_db instanceof PostgresAdapter) {
          _lock = new PostgresLockAdapter((_db as any).pool, ttl);
        } else {
          _lock = new DbLockAdapter(url ?? "oqron.sqlite", ttl);
        }
      } else if (adapter === "memory") {
        _lock = new MemoryLockAdapter();
      } else {
        throw new Error(
          `[OqronKit] Lock adapter '${adapter}' not yet bundled. Please pass a custom ILockAdapter instance.`,
        );
      }
    } else {
      _lock = _config.lock as ILockAdapter;
    }

    // --- Shutdown hooks ---
    if (_config.shutdown.enabled) {
      for (const signal of _config.shutdown.signals) {
        process.on(signal, () => {
          _logger?.info(`${signal} received — initiating graceful shutdown…`);
          void this.stop().then(() => process.exit(0));
        });
      }
    }

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

      // Inject global config tags onto all cron jobs natively
      for (const s of schedules) {
        s.tags = [...new Set([...(s.tags ?? []), ..._config.tags])];
      }

      const nsDb = new NamespacedOqronAdapter(
        _db!,
        _config.project,
        _config.environment,
      );
      const nsLock = new NamespacedLockAdapter(
        _lock!,
        _config.project,
        _config.environment,
      );

      const scheduler = new SchedulerModule(
        schedules,
        nsDb,
        nsLock,
        _logger!,
        _config.environment,
        _config.project,
        _config.cron,
      );
      OqronRegistry.getInstance().register(scheduler);
    }

    if (_config.modules.includes("scheduler")) {
      const { ScheduleEngine, _drainPendingSchedules } = await import(
        "./scheduler/index.js"
      );

      // The file scan happens above during 'cron' if both are enabled.
      // If ONLY 'scheduler' is enabled, we need to do the file scan here.
      if (!_config.modules.includes("cron") && _config.jobsDir) {
        _logger.warn(
          "jobsDir scanning currently bound to cron module block. Consider enabling 'cron' module or creating global scanner.",
        );
      }

      // Collect all auto-registered definitions
      const schedules = _drainPendingSchedules();

      // Inject global config tags onto all schedule jobs natively
      for (const s of schedules) {
        s.tags = [...new Set([...(s.tags ?? []), ..._config.tags])];
      }

      const nsDb = new NamespacedOqronAdapter(
        _db!,
        _config.project,
        _config.environment,
      );
      const nsLock = new NamespacedLockAdapter(
        _lock!,
        _config.project,
        _config.environment,
      );

      const engine = new ScheduleEngine(
        schedules,
        nsDb,
        nsLock,
        _logger!,
        _config.environment,
        _config.project,
        _config.scheduler,
      );
      OqronRegistry.getInstance().register(engine);
    }

    // --- Boot all registered modules ---
    const registry = OqronRegistry.getInstance();
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

    _logger.info("OqronKit ready ✓");
  },

  /** Gracefully stop all modules */
  async stop(): Promise<void> {
    const log =
      _logger ??
      createLogger({ enabled: true, level: "info" }, { module: "oqronkit" });
    log.info("Stopping OqronKit…");

    const timeoutMs = _config?.shutdown.timeout ?? 30000;
    const registry = OqronRegistry.getInstance();

    const stopPromise = Promise.all(
      registry
        .getAll()
        .filter((m) => m.enabled)
        .map((m) => m.stop()),
    );

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(new Error(`Graceful shutdown timed out after ${timeoutMs}ms`)),
        timeoutMs,
      ),
    );

    try {
      await Promise.race([stopPromise, timeoutPromise]);
      log.info("OqronKit stopped.");
    } catch (err) {
      log.error("Error during stop or shutdown timeout", {
        error: String(err),
      });
    }
  },

  /** Get the current validated config */
  getConfig(): ValidatedConfig {
    if (!_config)
      throw new Error(
        "[OqronKit] Not initialized yet. Call OqronKit.init() first.",
      );
    return _config;
  },

  /** Get the database adapter (available after init()) */
  getDb(): IOqronAdapter {
    if (!_db) throw new Error("[OqronKit] Not initialized yet.");
    return _db;
  },

  /** Get the lock adapter (available after init()) */
  getLock(): ILockAdapter {
    if (!_lock) throw new Error("[OqronKit] Not initialized yet.");
    return _lock;
  },

  /** Pause a schedule from natively executing */
  async pause(scheduleId: string): Promise<void> {
    if (!_db) throw new Error("[OqronKit] Not initialized yet.");
    if (_config?.project && _config?.environment) {
      await new NamespacedOqronAdapter(
        _db,
        _config.project,
        _config.environment,
      ).pauseSchedule(scheduleId);
    } else {
      await _db.pauseSchedule(scheduleId);
    }
  },

  /** Resume a previously paused schedule */
  async resume(scheduleId: string): Promise<void> {
    if (!_db) throw new Error("[OqronKit] Not initialized yet.");
    if (_config?.project && _config?.environment) {
      await new NamespacedOqronAdapter(
        _db,
        _config.project,
        _config.environment,
      ).resumeSchedule(scheduleId);
    } else {
      await _db.resumeSchedule(scheduleId);
    }
  },

  /** Get the Express router for monitoring */
  expressRouter() {
    return expressRouter();
  },

  /** Get the Fastify plugin for monitoring */
  fastifyPlugin(fastify: any, opts: any, done: () => void) {
    return fastifyPlugin(fastify, opts, done);
  },

  /** Get Prometheus-formatted metrics text */
  getMetrics(): string {
    if (!_telemetry) {
      _telemetry = new TelemetryManager();
      _telemetry.start();
    }
    return _telemetry.serialize();
  },

  /** Get the telemetry manager instance (for engine-level recording) */
  getTelemetry(): TelemetryManager {
    if (!_telemetry) {
      _telemetry = new TelemetryManager();
      _telemetry.start();
    }
    return _telemetry;
  },
};

export default OqronKit;
