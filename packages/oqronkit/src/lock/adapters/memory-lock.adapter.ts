import type { ILockAdapter } from "../../core/index.js";

/**
 * In-memory lock adapter for single-node dev/testing.
 * Uses a Map + setTimeout-based expiry — NOT suitable for production multi-node.
 */
export class MemoryLockAdapter implements ILockAdapter {
  private readonly locks = new Map<
    string,
    { ownerId: string; expiresAt: number }
  >();

  async acquire(key: string, ownerId: string, ttlMs: number): Promise<boolean> {
    const existing = this.locks.get(key);
    if (existing && existing.expiresAt > Date.now()) {
      return existing.ownerId === ownerId;
    }
    this.locks.set(key, { ownerId, expiresAt: Date.now() + ttlMs });
    return true;
  }

  async renew(key: string, ownerId: string, ttlMs: number): Promise<boolean> {
    const existing = this.locks.get(key);
    if (!existing || existing.ownerId !== ownerId) return false;
    existing.expiresAt = Date.now() + ttlMs;
    return true;
  }

  async release(key: string, ownerId: string): Promise<void> {
    const existing = this.locks.get(key);
    if (existing?.ownerId === ownerId) this.locks.delete(key);
  }

  async isOwner(key: string, ownerId: string): Promise<boolean> {
    const existing = this.locks.get(key);
    return (
      !!existing &&
      existing.ownerId === ownerId &&
      existing.expiresAt > Date.now()
    );
  }
}
