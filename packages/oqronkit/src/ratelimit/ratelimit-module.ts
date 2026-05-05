import type { OqronConfig } from "../engine/types/config.types.js";
import type { RateLimitModuleDef } from "../modules.js";
import type { IOqronModule } from "../engine/types/module.types.js";
import type { Logger } from "../engine/index.js";
import { OqronContainer } from "../engine/container.js";
import { OqronEventBus } from "../engine/events/event-bus.js";
import type { RateLimitInstanceRecord, RateLimitStats } from "./types.js";
import { getRegisteredLimiters } from "./registry.js";

/**
 * RateLimitModule — The single owner of the rate-limit management plane.
 *
 * Responsibilities:
 * 1. Persist all registered limiter instances to storage on init()
 * 2. Load enabled/disabled state from storage for each instance
 * 3. Run background GC for expired algorithm state, bans, violations, warnings
 * 4. Prune old block/ban audit events beyond retention window
 * 5. Flush batched stats (when statsFlushIntervalMs > 0)
 */
export class RateLimitModule implements IOqronModule {
  readonly name = "ratelimit";
  enabled = true;

  private _timer: NodeJS.Timeout | null = null;
  private _initialTimer: NodeJS.Timeout | null = null;
  private readonly _tickMs: number;
  private readonly _eventRetentionMs: number;

  constructor(
    _config: OqronConfig,
    private readonly logger: Logger,
    private readonly moduleConfig: RateLimitModuleDef,
  ) {
    this._tickMs = moduleConfig.gcIntervalMs ?? 300_000; // 5 min default
    this._eventRetentionMs = moduleConfig.eventRetentionMs ?? 86_400_000; // 24h
  }

  async init(): Promise<void> {
    const container = OqronContainer.tryGet();
    if (!container) return;

    const storage = container.storage;
    const limiters = getRegisteredLimiters();

    // Persist all registered instances
    for (const limiter of limiters) {
      limiter.applyModuleDefaults?.({
        algorithm: this.moduleConfig.algorithm,
        failOpen: this.moduleConfig.failOpen,
        jitter: this.moduleConfig.jitter,
        disabledBehavior: this.moduleConfig.disabledBehavior,
      });
      const config = (limiter as any).config;
      if (!config) continue;

      // Load existing record (may have enabled/disabled state from dashboard)
      const existing = await storage.get<RateLimitInstanceRecord>(
        "ratelimit_instances",
        limiter.name,
      );

      const record: RateLimitInstanceRecord = {
        name: limiter.name,
        algorithm: config.algorithm ?? "sliding-window",
        tierNames: (config.tiers ?? []).map((t: any) => t.name),
        dryRun: config.dryRun ?? false,
        failOpen: config.failOpen ?? false,
        enabled: existing?.enabled ?? true,
        disabledBehavior: config.disabledBehavior ?? "skip",
        createdAt: existing?.createdAt ?? new Date(),
        tags: config.tags ?? [],
      };

      await storage.save("ratelimit_instances", limiter.name, record);

      // Initialize stats if not exists
      const existingStats = await storage.get<RateLimitStats>(
        "ratelimit_stats",
        limiter.name,
      );
      if (!existingStats) {
        const initialStats: RateLimitStats = {
          name: limiter.name,
          totalChecks: 0,
          totalAllowed: 0,
          totalBlocked: 0,
          totalBanned: 0,
          totalSkipped: 0,
          lastCheckAt: 0,
          lastBlockAt: null,
          tierStats: {},
        };
        await storage.save("ratelimit_stats", limiter.name, initialStats);
      }

      OqronEventBus.emit(
        "ratelimit:instance:created",
        limiter.name,
        record.algorithm,
        record.tierNames,
      );
    }

    this.logger.info(
      `RateLimit module initialized with ${limiters.length} limiter(s)`,
    );
  }

  async start(): Promise<void> {
    if (!this.enabled) return;
    this._startLoop();
    this.logger.info("RateLimit module started.");
  }

  async stop(): Promise<void> {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this._initialTimer) {
      clearTimeout(this._initialTimer);
      this._initialTimer = null;
    }
  }

  async enable(): Promise<void> {
    this.enabled = true;
    this._startLoop();
  }

  async disable(): Promise<void> {
    this.enabled = false;
    await this.stop();
  }

  private _startLoop(): void {
    if (this._timer) return;
    this._timer = setInterval(() => void this._tick(), this._tickMs);
    if (this._timer.unref) this._timer.unref();

    // Initial cleanup after a short delay (let the rest of the system boot)
    this._initialTimer = setTimeout(() => {
      this._initialTimer = null;
      void this._tick();
    }, 10_000);
    if (this._initialTimer.unref) this._initialTimer.unref();
  }

  // ── Management Tick ──────────────────────────────────────────────────────

  private async _tick(): Promise<void> {
    try {
      const container = OqronContainer.tryGet();
      if (!container) return;

      const storage = container.storage;
      const now = Date.now();

      // 1. GC: prune expired algorithm state
      const algoNamespaces = [
        "ratelimit:sliding",
        "ratelimit:bucket",
        "ratelimit:fixed",
      ];
      for (const ns of algoNamespaces) {
        await storage.prune(ns, now);
      }

      // 2. GC: prune expired bans, violations, warnings
      const gcNamespaces = [
        "ratelimit:bans",
        "ratelimit:violations",
        "ratelimit:warnings",
        "ratelimit:circuit",
      ];
      for (const ns of gcNamespaces) {
        await storage.prune(ns, now);
      }

      // 3. Prune old block events beyond retention window
      const eventCutoff = now - this._eventRetentionMs;
      await storage.prune("ratelimit_events", eventCutoff);
    } catch (err) {
      this.logger.warn(`RateLimit GC tick failed: ${err}`);
    }
  }
}
