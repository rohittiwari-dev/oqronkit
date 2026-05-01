import type { IStorageEngine, ListOptions, WhereCondition } from "../types/engine.js";

/**
 * Memory-based implementation of the Storage Engine.
 * Used automatically when no Redis URL is provided.
 * Internally uses Map<Namespace, Map<Id, Data>>.
 */
export class MemoryStore implements IStorageEngine {
  private namespaces = new Map<string, Map<string, any>>();

  private getNamespaceMap(namespace: string): Map<string, any> {
    let map = this.namespaces.get(namespace);
    if (!map) {
      map = new Map();
      this.namespaces.set(namespace, map);
    }
    return map;
  }

  async save<T>(namespace: string, id: string, data: T): Promise<void> {
    const map = this.getNamespaceMap(namespace);
    map.set(id, this.clone(data));
  }

  async get<T>(namespace: string, id: string): Promise<T | null> {
    const map = this.getNamespaceMap(namespace);
    const data = map.get(id);
    return data ? this.clone(data) : null;
  }

  async list<T>(
    namespace: string,
    filter?: Record<string, any>,
    opts?: ListOptions,
  ): Promise<T[]> {
    const map = this.getNamespaceMap(namespace);
    let results: T[] = Array.from(map.values()).map((item) =>
      this.clone(item),
    ) as T[];

    if (filter) {
      results = results.filter((item: any) => {
        for (const [key, val] of Object.entries(filter)) {
          if (item[key] !== val) return false;
        }
        return true;
      });
    }

    //  Apply comparison conditions
    if (opts?.where) {
      results = results.filter((item: any) =>
        this.matchesWhere(item, opts.where!),
      );
    }

    // Sort by createdAt descending (newest first)
    results.sort((a: any, b: any) => {
      const aTime = this.toEpochMs(a.createdAt) ?? 0;
      const bTime = this.toEpochMs(b.createdAt) ?? 0;
      return bTime - aTime;
    });

    // Apply pagination
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit;
    if (limit !== undefined) {
      return results.slice(offset, offset + limit);
    }
    if (offset > 0) {
      return results.slice(offset);
    }

    return results;
  }

  async count(
    namespace: string,
    filter?: Record<string, any>,
  ): Promise<number> {
    const map = this.getNamespaceMap(namespace);
    if (!filter) return map.size;

    let count = 0;
    for (const item of map.values()) {
      let matches = true;
      if (filter) {
        for (const [key, val] of Object.entries(filter)) {
          if (item[key] !== val) {
            matches = false;
            break;
          }
        }
      }
      if (matches) count++;
    }
    return count;
  }

  async delete(namespace: string, id: string): Promise<void> {
    const map = this.getNamespaceMap(namespace);
    map.delete(id);
  }

  async prune(namespace: string, beforeMs: number): Promise<number> {
    const map = this.getNamespaceMap(namespace);
    let prunedCount = 0;

    for (const [id, value] of map.entries()) {
      const createdAt = value?.createdAt;
      let createdAtMs: number | undefined;

      if (createdAt instanceof Date) {
        createdAtMs = createdAt.getTime();
      } else if (typeof createdAt === "string") {
        createdAtMs = new Date(createdAt).getTime();
      } else if (typeof createdAt === "number") {
        createdAtMs = createdAt;
      }

      if (
        createdAtMs !== undefined &&
        !Number.isNaN(createdAtMs) &&
        createdAtMs < beforeMs
      ) {
        map.delete(id);
        prunedCount++;
      }
    }

    return prunedCount;
  }

  // ── Where condition helpers ──────────────────────────────────────────────

  /** Evaluates an item against all WhereConditions (AND semantics) */
  private matchesWhere(item: any, conditions: WhereCondition[]): boolean {
    for (const cond of conditions) {
      const raw = item[cond.field];
      // Null/undefined fields never match comparison operators
      if (raw === null || raw === undefined) return false;

      const a = this.toEpochMs(raw) ?? raw;
      const b = this.toEpochMs(cond.value) ?? cond.value;

      switch (cond.op) {
        case "$lt":  if (!(a < (b as any))) return false; break;
        case "$lte": if (!(a <= (b as any))) return false; break;
        case "$gt":  if (!(a > (b as any))) return false; break;
        case "$gte": if (!(a >= (b as any))) return false; break;
        case "$ne":  if (!(a !== b)) return false; break;
      }
    }
    return true;
  }

  private toEpochMs(value: unknown): number | undefined {
    if (value instanceof Date) return value.getTime();
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = new Date(value).getTime();
      return Number.isNaN(parsed) ? undefined : parsed;
    }
    return undefined;
  }

  private clone<T>(value: T, seen = new WeakMap<object, any>()): T {
    if (value === null || typeof value !== "object") return value;
    if (value instanceof Date) return new Date(value.getTime()) as T;
    if (typeof value === "function") return value;
    if (seen.has(value as object)) return seen.get(value as object);

    if (Array.isArray(value)) {
      const out: any[] = [];
      seen.set(value, out);
      for (const item of value) out.push(this.clone(item, seen));
      return out as T;
    }

    const out: Record<string, unknown> = {};
    seen.set(value as object, out);
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = this.clone(item, seen);
    }
    return out as T;
  }
}
