import type { Logger } from "./logger/index.js";

/**
 * Event Loop Lag Monitor (Circuit Breaker)
 *
 * Node.js runs on a single thread. If a job performs incredibly heavy
 * chrono operations (e.g. huge JSON.parse, infinite while loop),
 * it blocks the Event Loop entirely, causing all active timeouts to delay.
 *
 * This monitor continuously polls the loop. If the delay between ticks
 * exceeds the configured threshold, it trips the circuit breaker allowing
 * the OqronKit engines to abort fetching new jobs until the CPU recovers!
 */
export class LagMonitor {
  private timer?: ReturnType<typeof setInterval>;
  private lastTickMs: number = 0;
  private currentLagMs: number = 0;
  private isStalled: boolean = false;

  constructor(
    private readonly logger: Logger,
    private readonly maxLagMs: number = 500,
    private readonly sampleIntervalMs: number = 50,
  ) {}

  public start(): void {
    if (this.timer) return;
    this.lastTickMs = Date.now();
    this.timer = setInterval(() => {
      const now = Date.now();
      const expected = this.lastTickMs + this.sampleIntervalMs;
      this.currentLagMs = Math.max(0, now - expected);

      const wasStalled = this.isStalled;
      this.isStalled = this.currentLagMs >= this.maxLagMs;

      if (this.isStalled && !wasStalled) {
        this.logger.warn(
          `[Circuit Breaker] Event Loop LAG detected! CPU is stalled by ${this.currentLagMs}ms. Pausing new job fetches.`,
        );
      } else if (!this.isStalled && wasStalled) {
        this.logger.info(
          `[Circuit Breaker] Event Loop recovered. Resuming job fetches.`,
        );
      }

      this.lastTickMs = now;
    }, this.sampleIntervalMs);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.isStalled = false;
  }

  public get isCircuitTripped(): boolean {
    return this.isStalled;
  }
}
