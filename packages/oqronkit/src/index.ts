import fs from "node:fs/promises";
import path from "node:path";
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
import { expressRouter as _expressRouter } from "./server/express.js";
import { fastifyPlugin as _fastifyPlugin } from "./server/fastify.js";
import { TelemetryManager } from "./telemetry/index.js";

let _config: ValidatedConfig | null = null;
let _logger: Logger | null = null;
let _telemetry: TelemetryManager | null = null;

export type {
  CronDefinition,
  CronHooks,
  EveryConfig,
  ICronContext,
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
} from "./engine/index.js";
// ── Re-exports: single source of truth for ALL user-facing APIs ─────────────
export { createLogger, defineConfig, OqronEventBus } from "./engine/index.js";

export { OqronManager } from "./manager/oqron-manager.js";
export { FlowProducer } from "./queue/distributed/flow-producer.js";
export { Queue } from "./queue/distributed/queue.js";
export { QueueEvents } from "./queue/distributed/queue-events.js";
export { Worker } from "./queue/distributed/worker.js";
export {
  cron,
  type DefineCronOptions,
  type DefineScheduleOptions,
  type ScheduleInstance,
  schedule,
} from "./scheduler/index.js";
export { taskQueue } from "./task-queue/define-task-queue.js";
export type {
  ITaskQueue,
  TaskJobContext,
  TaskQueueConfig,
} from "./task-queue/types.js";

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

    // --- Boot modules ---
    if (_config.modules.includes("cron")) {
      const { SchedulerModule, _drainPending } = await import(
        "./scheduler/index.js"
      );
      if (_config.jobsDir) {
        const jobsPath = path.resolve(cwd, _config.jobsDir);
        try {
          async function scan(dir: string) {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
              const fullPath = path.join(dir, entry.name);
              if (entry.isDirectory()) await scan(fullPath);
              else if (
                entry.isFile() &&
                /\.(js|ts|mjs|cjs)$/.test(entry.name)
              ) {
                await import(pathToFileURL(fullPath).toString());
              }
            }
          }
          await scan(jobsPath);
        } catch (_err) {}
      }
      const schedules = _drainPending();
      for (const s of schedules)
        s.tags = [...new Set([...(s.tags ?? []), ..._config.tags])];
      const scheduler = new SchedulerModule(
        schedules,
        _logger!,
        _config.environment,
        _config.project,
        _config.cron,
      );
      OqronRegistry.getInstance().register(scheduler);
    }

    if (_config.modules.includes("taskQueue")) {
      const { TaskQueueEngine } = await import(
        "./task-queue/task-queue-engine.js"
      );
      const engine = new TaskQueueEngine(_config, _logger!);
      OqronRegistry.getInstance().register(engine);
    }

    if (_config.modules.includes("worker")) {
      const { WorkerEngine } = await import(
        "./queue/distributed/worker-engine.js"
      );
      const engine = new WorkerEngine(_config, _logger!);
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
    const s = (await Storage.get("schedules", scheduleId)) as any;
    if (s) await Storage.save("schedules", scheduleId, { ...s, paused: true });
  },

  async resume(scheduleId: string): Promise<void> {
    const s = (await Storage.get("schedules", scheduleId)) as any;
    if (s) await Storage.save("schedules", scheduleId, { ...s, paused: false });
  },

  expressRouter() {
    return _expressRouter();
  },
  fastifyPlugin(fastify: any, opts: any, done: () => void) {
    return _fastifyPlugin(fastify, opts, done);
  },
  getMetrics(): string {
    if (!_telemetry) {
      _telemetry = new TelemetryManager();
      _telemetry.start();
    }
    return _telemetry.serialize();
  },
  getTelemetry(): TelemetryManager {
    if (!_telemetry) {
      _telemetry = new TelemetryManager();
      _telemetry.start();
    }
    return _telemetry;
  },
};

export default OqronKit;
