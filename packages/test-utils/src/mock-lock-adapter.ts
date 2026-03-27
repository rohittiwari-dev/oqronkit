import type { ILockAdapter } from "@chronoforge/core";

/** In-memory lock adapter for unit testing */
export class MockLockAdapter implements ILockAdapter {
  private readonly locks = new Map<
    string,
    { ownerId: string; expiresAt: number }
  >();

  async acquire(key: string, ownerId: string, ttlMs: number): Promise<boolean> {
    const existing = this.locks.get(key);
    if (existing && existing.expiresAt > Date.now()) {
      return existing.ownerId === ownerId; // Already own it = true
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
