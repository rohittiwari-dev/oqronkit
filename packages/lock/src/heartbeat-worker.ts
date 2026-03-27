import type { ILockAdapter, Logger } from "@chronoforge/core";

export class HeartbeatWorker {
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private _active = false;

  constructor(
    private readonly lock: ILockAdapter,
    private readonly logger: Logger,
    private readonly key: string,
    private readonly ownerId: string,
    private readonly ttlMs: number = 30_000,
  ) {}

  async start(): Promise<boolean> {
    const acquired = await this.lock.acquire(
      this.key,
      this.ownerId,
      this.ttlMs,
    );
    if (!acquired) return false;

    this._active = true;
    const pingInterval = Math.floor(this.ttlMs / 3);

    this.heartbeatTimer = setInterval(async () => {
      if (!this._active) return;
      try {
        const renewed = await this.lock.renew(
          this.key,
          this.ownerId,
          this.ttlMs,
        );
        if (!renewed) {
          this.logger.warn("Heartbeat renewal failed — lock lost", {
            key: this.key,
            ownerId: this.ownerId,
          });
          this._active = false;
          clearInterval(this.heartbeatTimer);
        }
      } catch (err) {
        this.logger.error("Heartbeat renewal threw", {
          key: this.key,
          err: String(err),
        });
      }
    }, pingInterval);

    return true;
  }

  async stop(): Promise<void> {
    this._active = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    try {
      await this.lock.release(this.key, this.ownerId);
    } catch (err) {
      this.logger.error("Failed to release lock cleanly", {
        key: this.key,
        err: String(err),
      });
    }
  }

  get isActive(): boolean {
    return this._active;
  }
}
