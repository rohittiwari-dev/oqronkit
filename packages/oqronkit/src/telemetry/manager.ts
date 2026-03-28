import { OqronEventBus } from "../core/events/event-bus.js";

/**
 * TelemetryManager — Prometheus-compatible metrics collector for OqronKit.
 *
 * Hooks into the internal OqronEventBus to automatically track:
 * - Active jobs per schedule
 * - Completed/Failed job totals per schedule
 * - Job duration histograms
 *
 * Exposes a text-based `/metrics` endpoint compatible with Prometheus scraping.
 *
 * Usage with Express:
 * ```ts
 * app.get("/metrics", (req, res) => {
 *   res.set("Content-Type", "text/plain");
 *   res.send(telemetry.serialize());
 * });
 * ```
 */
export class TelemetryManager {
  // ── Counters ────────────────────────────────────────────────────
  private jobsStartedTotal = new Map<string, number>();
  private jobsCompletedTotal = new Map<string, number>();
  private jobsFailedTotal = new Map<string, number>();
  private jobsActiveGauge = new Map<string, number>();
  private jobDurationsMs: Array<{ schedule: string; duration: number }> = [];

  private started = false;

  /** Start listening for events from the internal OqronKit EventBus */
  start(): void {
    if (this.started) return;
    this.started = true;

    OqronEventBus.on("job:start", (_jobId: string, module: string) => {
      this.increment(this.jobsStartedTotal, module);
      this.increment(this.jobsActiveGauge, module);
    });

    OqronEventBus.on("job:success", (_jobId: string) => {
      // We can't easily get the module name from just jobId here,
      // so we track via a broader "global" counter.
      this.increment(this.jobsCompletedTotal, "_global");
    });

    OqronEventBus.on("job:fail", (_jobId: string, _error: Error) => {
      this.increment(this.jobsFailedTotal, "_global");
    });
  }

  /** Record a completed job with its duration (called from engine internals) */
  recordCompletion(
    scheduleName: string,
    durationMs: number,
    status: "completed" | "failed",
  ): void {
    if (status === "completed") {
      this.increment(this.jobsCompletedTotal, scheduleName);
    } else {
      this.increment(this.jobsFailedTotal, scheduleName);
    }
    this.decrement(this.jobsActiveGauge, scheduleName);
    this.jobDurationsMs.push({ schedule: scheduleName, duration: durationMs });

    // Keep only the last 10,000 duration samples to prevent memory leak
    if (this.jobDurationsMs.length > 10_000) {
      this.jobDurationsMs = this.jobDurationsMs.slice(-5_000);
    }
  }

  /** Record a job start */
  recordStart(scheduleName: string): void {
    this.increment(this.jobsStartedTotal, scheduleName);
    this.increment(this.jobsActiveGauge, scheduleName);
  }

  /** Stop listening and reset all counters */
  stop(): void {
    this.started = false;
    OqronEventBus.removeAllListeners();
    this.jobsStartedTotal.clear();
    this.jobsCompletedTotal.clear();
    this.jobsFailedTotal.clear();
    this.jobsActiveGauge.clear();
    this.jobDurationsMs = [];
  }

  // ── Prometheus Serializer ───────────────────────────────────────

  /**
   * Serialize all collected metrics into Prometheus text format.
   * Mount this on an Express/Fastify route:
   *
   * ```ts
   * app.get("/metrics", (req, res) => {
   *   res.set("Content-Type", "text/plain; version=0.0.4");
   *   res.send(OqronKit.getMetrics());
   * });
   * ```
   */
  serialize(): string {
    const lines: string[] = [];

    // ── HELP and TYPE declarations ──
    lines.push(
      "# HELP oqronkit_jobs_started_total Total number of jobs started",
    );
    lines.push("# TYPE oqronkit_jobs_started_total counter");
    for (const [schedule, count] of this.jobsStartedTotal) {
      lines.push(
        `oqronkit_jobs_started_total{schedule="${schedule}"} ${count}`,
      );
    }

    lines.push("");
    lines.push(
      "# HELP oqronkit_jobs_completed_total Total number of jobs completed successfully",
    );
    lines.push("# TYPE oqronkit_jobs_completed_total counter");
    for (const [schedule, count] of this.jobsCompletedTotal) {
      lines.push(
        `oqronkit_jobs_completed_total{schedule="${schedule}"} ${count}`,
      );
    }

    lines.push("");
    lines.push(
      "# HELP oqronkit_jobs_failed_total Total number of jobs that failed",
    );
    lines.push("# TYPE oqronkit_jobs_failed_total counter");
    for (const [schedule, count] of this.jobsFailedTotal) {
      lines.push(`oqronkit_jobs_failed_total{schedule="${schedule}"} ${count}`);
    }

    lines.push("");
    lines.push("# HELP oqronkit_jobs_active Current number of jobs in-flight");
    lines.push("# TYPE oqronkit_jobs_active gauge");
    for (const [schedule, count] of this.jobsActiveGauge) {
      if (count > 0) {
        lines.push(`oqronkit_jobs_active{schedule="${schedule}"} ${count}`);
      }
    }

    // ── Duration summary (avg, p50, p95, p99) ──
    if (this.jobDurationsMs.length > 0) {
      const schedules = new Set(this.jobDurationsMs.map((d) => d.schedule));

      lines.push("");
      lines.push(
        "# HELP oqronkit_job_duration_ms Job execution duration in milliseconds",
      );
      lines.push("# TYPE oqronkit_job_duration_ms summary");

      for (const sched of schedules) {
        const durations = this.jobDurationsMs
          .filter((d) => d.schedule === sched)
          .map((d) => d.duration)
          .sort((a, b) => a - b);

        const count = durations.length;
        const sum = durations.reduce((a, b) => a + b, 0);
        const p50 = durations[Math.floor(count * 0.5)] ?? 0;
        const p95 = durations[Math.floor(count * 0.95)] ?? 0;
        const p99 = durations[Math.floor(count * 0.99)] ?? 0;

        lines.push(
          `oqronkit_job_duration_ms{schedule="${sched}",quantile="0.5"} ${p50}`,
        );
        lines.push(
          `oqronkit_job_duration_ms{schedule="${sched}",quantile="0.95"} ${p95}`,
        );
        lines.push(
          `oqronkit_job_duration_ms{schedule="${sched}",quantile="0.99"} ${p99}`,
        );
        lines.push(`oqronkit_job_duration_ms_sum{schedule="${sched}"} ${sum}`);
        lines.push(
          `oqronkit_job_duration_ms_count{schedule="${sched}"} ${count}`,
        );
      }
    }

    lines.push("");
    return lines.join("\n");
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private increment(map: Map<string, number>, key: string): void {
    map.set(key, (map.get(key) ?? 0) + 1);
  }

  private decrement(map: Map<string, number>, key: string): void {
    const val = map.get(key) ?? 0;
    map.set(key, Math.max(0, val - 1));
  }
}
