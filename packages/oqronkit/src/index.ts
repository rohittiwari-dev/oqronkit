import { access, readdir } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { initEngine, Storage, stopEngine } from "./engine/core.js";
import {
  createLogger,
  type Logger,
  loadConfig,
  type OqronConfig,
  OqronRegistry,
  reconfigureConfig,
  type ValidatedConfig,
} from "./engine/index.js";
import {
  type CronModuleDef,
  getModuleConfig,
  type QueueModuleDef,
  type SchedulerModuleDef,
} from "./modules.js";
import { expressRouter as _expressRouter } from "./server/express.js";
import { fastifyPlugin as _fastifyPlugin } from "./server/fastify.js";
import { TelemetryManager } from "./telemetry/index.js";

let _config: ValidatedConfig | null = null;
let _logger: Logger | null = null;

export type {
  ClusteringConfig,
  CronDefinition,
  CronHooks,
  EveryConfig,
  ICronContext,
  IScheduleContext,
  JobLogEntry,
  JobRecord,
  JobTimelineEntry,
  JobTriggerSource,
  Logger,
  MissedFirePolicy,
  OqronLoggerConfig,
  OverlapPolicy,
  RetryConfig,
  ScheduleDefinition,
  ScheduleHooks,
  ScheduleRecurring,
  ScheduleRunAfter,
} from "./engine/index.js";
// ── Re-exports: single source of truth for ALL user-facing APIs ─────────────
export {
  createLogger,
  DependencyResolver,
  defineConfig,
  OqronContainer,
  OqronEventBus,
} from "./engine/index.js";
export { ShardedLeaderElection } from "./engine/lock/index.js";
export {
  type JobHistoryResult,
  type ModuleInfo,
  OqronManager,
  type QueueInfoResult,
  type QueueMetrics,
} from "./manager/oqron-manager.js";
// ── Module factories ────────────────────────────────────────────────────────
export {
  type CronModuleConfig,
  type CronModuleDef,
  cronModule,
  getModuleConfig,
  normalizeModules,
  type OqronModuleDef,
  type OqronModuleInput,
  type OqronModuleName,
  type QueueModuleConfig,
  type QueueModuleDef,
  queueModule,
  type SchedulerModuleConfig,
  type SchedulerModuleDef,
  scheduleModule,
} from "./modules.js";
export { queue } from "./queue/define-queue.js";
export type { IQueue, QueueConfig, QueueJobContext } from "./queue/types.js";
export {
  cron,
  type DefineCronOptions,
  type DefineScheduleOptions,
  type ScheduleInstance,
  schedule,
} from "./scheduler/index.js";

// ── Trigger Auto-Discovery ──────────────────────────────────────────────────

/** Well-known directories checked when `triggers` is not set */
const TRIGGER_PROBE_PATHS = ["src/triggers", "triggers", "src/jobs", "jobs"];

/** Recursively import all .ts/.js files in a directory */
async function scanDir(dir: string): Promise<number> {
  let count = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      count += await scanDir(full);
    } else if (entry.isFile() && /\.(js|ts|mjs|cjs)$/.test(entry.name)) {
      await import(pathToFileURL(full).toString());
      count++;
      ``;
    }
  }
  return count;
}

async function discoverTriggers(
  config: ValidatedConfig,
  cwd: string,
  logger: Logger,
): Promise<void> {
  // Explicitly disabled
  if (config.triggers === false) return;

  // Explicit path provided
  if (typeof config.triggers === "string") {
    const resolved = path.resolve(cwd, config.triggers);
    try {
      await access(resolved);
      const count = await scanDir(resolved);
      logger.info(`Loaded ${count} trigger file(s) from ${config.triggers}`);
    } catch {
      logger.warn(
        `Triggers directory "${config.triggers}" not found at ${resolved}. ` +
          `Ensure trigger files are imported manually before OqronKit.init().`,
      );
    }
    return;
  }

  // Auto-detect: probe common directories
  for (const probe of TRIGGER_PROBE_PATHS) {
    const resolved = path.resolve(cwd, probe);
    try {
      await access(resolved);
      const count = await scanDir(resolved);
      logger.info(`Auto-discovered ${count} trigger file(s) from ${probe}/`);
      return;
    } catch {
      // Not found — try next
    }
  }

  // Nothing found — warn with guidance
  logger.warn(
    "No triggers directory found. OqronKit checked: " +
      TRIGGER_PROBE_PATHS.join(", ") +
      ". To fix: (1) create a triggers/ directory, (2) set config.triggers to an explicit path, " +
      "or (3) import job files manually before OqronKit.init(). " +
      "Set triggers: false to silence this warning.",
  );
}

export const OqronKit = {
  /**
   * Initialize OqronKit: loads config and boots modules.
   *
   * @param opts.cwd - Working directory for config file lookup
   * @param opts.config - Explicit config object (skips loadConfig)
   */
  async init(opts?: { cwd?: string; config?: OqronConfig }): Promise<void> {
    const cwd = opts?.cwd ?? process.cwd();
    _config = reconfigureConfig(opts?.config ?? (await loadConfig(cwd)));

    const loggerConfig =
      _config.logger === false ? { enabled: true } : _config.logger;

    _logger = createLogger(loggerConfig, { module: "oqronkit" });

    _logger.info(`Starting OqronKit in "${_config.environment}" environment`);

    // --- Boot Engine ---
    await initEngine(_config);

    // --- Shutdown hooks ---
    if (_config.shutdown.enabled) {
      for (const signal of _config.shutdown.signals) {
        process.on(signal, () => {
          _logger?.info(`${signal} received — initiating graceful shutdown…`);
          void this.stop().then(() => process.exit(0));
        });
      }
    }

    // --- Auto-discover trigger/job definitions ---
    await discoverTriggers(_config, cwd, _logger);

    // --- Boot modules from normalized definitions ---
    const cronConf = getModuleConfig<CronModuleDef>(_config.modules, "cron");
    if (cronConf) {
      const { SchedulerModule, _drainPending } = await import(
        "./scheduler/index.js"
      );
      const schedules = _drainPending();
      for (const s of schedules)
        s.tags = [...new Set([...(s.tags ?? []), ..._config.tags])];
      const scheduler = new SchedulerModule(
        schedules,
        _logger!,
        _config.environment,
        _config.project,
        cronConf,
      );
      OqronRegistry.getInstance().register(scheduler);
    }

    const schedulerConf = getModuleConfig<SchedulerModuleDef>(
      _config.modules,
      "scheduler",
    );
    if (schedulerConf) {
      const { ScheduleEngine, _drainPendingSchedules } = await import(
        "./scheduler/index.js"
      );
      const schedules = _drainPendingSchedules();
      for (const s of schedules)
        s.tags = [...new Set([...(s.tags ?? []), ..._config.tags])];
      const scheduleEngine = new ScheduleEngine(
        schedules,
        _logger!,
        _config.environment,
        _config.project,
        schedulerConf,
      );
      OqronRegistry.getInstance().register(scheduleEngine);
    }

    const queueConf = getModuleConfig<QueueModuleDef>(_config.modules, "queue");
    if (queueConf) {
      const { QueueEngine } = await import("./queue/queue-engine.js");
      const engine = new QueueEngine(_config, _logger!, queueConf);
      OqronRegistry.getInstance().register(engine);
    }

    const registry = OqronRegistry.getInstance();
    for (const mod of registry.getAll()) {
      if (mod.enabled) await mod.init();
    }
    for (const mod of registry.getAll()) {
      if (mod.enabled) await mod.start();
    }

    _logger.info("OqronKit ready ✓");
    const { configureHandlers } = await import("./server/handlers.js");
    configureHandlers(registry, _config);

    // Start TelemetryManager — collects throughput, latency, memory from EventBus
    TelemetryManager.getInstance().start();
  },

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
      setTimeout(() => reject(new Error("Timeout")), timeoutMs),
    );
    try {
      await Promise.race([stopPromise, timeoutPromise]);
      await stopEngine();
      log.info("OqronKit stopped.");
    } catch (err) {
      log.error("Error during stop", { error: String(err) });
    }
  },

  getConfig(): ValidatedConfig {
    if (!_config) throw new Error("Not initialized");
    return _config;
  },

  async pause(scheduleId: string): Promise<void> {
    const s = await Storage.get<{ paused?: boolean }>("schedules", scheduleId);
    if (s) await Storage.save("schedules", scheduleId, { ...s, paused: true });
  },

  async resume(scheduleId: string): Promise<void> {
    const s = await Storage.get<{ paused?: boolean }>("schedules", scheduleId);
    if (s) await Storage.save("schedules", scheduleId, { ...s, paused: false });
  },

  /**
   * Returns a sealed configuration object for the OqronUI dashboard package.
   * Used as: `app.use("/oqron", OqronUI.register(OqronKit.ui()))`
   */
  ui(): {
    apiBasePath: string;
    auth?: { username?: string; password?: string };
    retention?: { runs?: string; events?: string; metrics?: string };
    project: string;
    environment: string;
    modules: string[];
  } {
    if (!_config) throw new Error("OqronKit.ui() called before init()");
    return {
      apiBasePath: "/api/oqron",
      auth: _config.ui?.auth,
      retention: _config.ui?.retention,
      project: _config.project ?? "unnamed",
      environment: _config.environment ?? "development",
      modules: (_config.modules ?? []).map((m) => m.module),
    };
  },

  expressRouter() {
    return _expressRouter();
  },
  fastifyPlugin(fastify: any, opts: any, done: () => void) {
    return _fastifyPlugin(fastify, opts, done);
  },
  getMetrics(): string {
    return TelemetryManager.getInstance().serialize();
  },
  getTelemetry(): TelemetryManager {
    return TelemetryManager.getInstance();
  },
};
