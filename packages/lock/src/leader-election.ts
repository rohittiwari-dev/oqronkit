import type { ILockAdapter, Logger } from "@chronoforge/core";

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
    const interval = Math.floor(this.ttlMs / 3);
    this.electionTimer = setInterval(() => void this.campaign(), interval);
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
