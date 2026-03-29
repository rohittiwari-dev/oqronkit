import type { ILockAdapter } from "../types/engine.js";

type LockEntry = {
  ownerId: string;
  expiresAt: number;
};

export class MemoryLock implements ILockAdapter {
  private locks = new Map<string, LockEntry>();

  async acquire(key: string, ownerId: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const existing = this.locks.get(key);

    if (!existing || existing.expiresAt < now) {
      this.locks.set(key, { ownerId, expiresAt: now + ttlMs });
      return true;
    }

    if (existing.ownerId === ownerId) {
      existing.expiresAt = now + ttlMs;
      return true;
    }

    return false;
  }

  async renew(key: string, ownerId: string, ttlMs: number): Promise<boolean> {
    const existing = this.locks.get(key);
    if (existing?.ownerId === ownerId && existing.expiresAt >= Date.now()) {
      existing.expiresAt = Date.now() + ttlMs;
      return true;
    }
    return false;
  }

  async release(key: string, ownerId: string): Promise<void> {
    const existing = this.locks.get(key);
    if (existing?.ownerId === ownerId) {
      this.locks.delete(key);
    }
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
