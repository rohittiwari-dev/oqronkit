export interface ILockAdapter {
  acquire(key: string, ownerId: string, ttlMs: number): Promise<boolean>;
  renew(key: string, ownerId: string, ttlMs: number): Promise<boolean>;
  release(key: string, ownerId: string): Promise<void>;
  isOwner(key: string, ownerId: string): Promise<boolean>;
}
//# sourceMappingURL=lock.types.d.ts.map
