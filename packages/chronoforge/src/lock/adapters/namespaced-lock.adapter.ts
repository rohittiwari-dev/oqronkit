import type { ILockAdapter } from "../../core/index.js";

export class NamespacedLockAdapter implements ILockAdapter {
  private readonly prefix: string;

  constructor(
    private readonly base: ILockAdapter,
    project: string = "default",
    environment: string = "development",
  ) {
    this.prefix = `${project}:${environment}:`;
  }

  private ns(key: string): string {
    return `${this.prefix}${key}`;
  }

  async acquire(key: string, ownerId: string, ttlMs: number): Promise<boolean> {
    return this.base.acquire(this.ns(key), ownerId, ttlMs);
  }

  async renew(key: string, ownerId: string, ttlMs: number): Promise<boolean> {
    return this.base.renew(this.ns(key), ownerId, ttlMs);
  }

  async release(key: string, ownerId: string): Promise<void> {
    return this.base.release(this.ns(key), ownerId);
  }

  async isOwner(key: string, ownerId: string): Promise<boolean> {
    return this.base.isOwner(this.ns(key), ownerId);
  }

  /**
   * Note: Some lock adapters might implement advanced prefixing natively,
   * but we proxy all core lock operations through the namespace.
   */
}
