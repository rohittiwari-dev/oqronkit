import type { Logger } from "../logger/index.js";
import type { ILockAdapter } from "../types/engine.js";

export class LeaderElection {
  private electionTimer?: ReturnType<typeof setInterval>;
  private _isLeader = false;

  constructor(
    private readonly lock: ILockAdapter,
    private readonly logger: Logger,
    private readonly leaderKey: string,
    private readonly nodeId: string,
    private readonly ttlMs: number = 30_000,
  ) {}

  async start(): Promise<void> {
    await this.campaign();
    // Add ±20% jitter to prevent thundering herd with many nodes
    const baseInterval = Math.floor(this.ttlMs / 3);
    const jitter = Math.floor(baseInterval * 0.2 * (Math.random() * 2 - 1));
    const interval = baseInterval + jitter;
    this.electionTimer = setInterval(() => void this.campaign(), interval);
    this.electionTimer.unref();
  }

  private async campaign(): Promise<void> {
    try {
      if (this._isLeader) {
        const ok = await this.lock.renew(
          this.leaderKey,
          this.nodeId,
          this.ttlMs,
        );
        if (!ok) {
          this._isLeader = false;
          this.logger.warn("Lost leadership", {
            leaderKey: this.leaderKey,
            nodeId: this.nodeId,
          });
        }
      } else {
        const ok = await this.lock.acquire(
          this.leaderKey,
          this.nodeId,
          this.ttlMs,
        );
        if (ok) {
          this._isLeader = true;
          this.logger.info("Became leader", {
            leaderKey: this.leaderKey,
            nodeId: this.nodeId,
          });
        }
      }
    } catch (err) {
      this.logger.error("Leader election error", {
        leaderKey: this.leaderKey,
        err: String(err),
      });
      this._isLeader = false;
    }
  }

  get isLeader(): boolean {
    return this._isLeader;
  }

  async stop(): Promise<void> {
    if (this.electionTimer) {
      clearInterval(this.electionTimer);
      this.electionTimer = undefined;
    }
    if (this._isLeader) {
      try {
        await this.lock.release(this.leaderKey, this.nodeId);
      } catch {
        // Best-effort
      }
      this._isLeader = false;
    }
  }
}
