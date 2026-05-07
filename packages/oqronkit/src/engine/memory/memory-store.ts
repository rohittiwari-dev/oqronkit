import type {
  IStorageEngine,
  ListOptions,
  WhereCondition,
} from "../types/engine.js";

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

  async saveIfAbsent<T>(
    namespace: string,
    id: string,
    data: T,
  ): Promise<boolean> {
    const map = this.getNamespaceMap(namespace);
    if (map.has(id)) return false;
    map.set(id, this.clone(data));
    return true;
  }

  async get<T>(namespace: string, id: string): Promise<T | null> {
    const map = this.getNamespaceMap(namespace);
    const data = map.get(id);
    return data !== undefined ? this.clone(data) : null;
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

    if (opts?.orderBy) {
      const { field, direction = "asc", type } = opts.orderBy;
      results.sort((a: any, b: any) => {
        const av = this.toComparable(a[field], type);
        const bv = this.toComparable(b[field], type);
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return direction === "asc" ? cmp : -cmp;
      });
    } else {
      // Sort by createdAt descending (newest first)
      results.sort((a: any, b: any) => {
        const aTime = this.toEpochMs(a.createdAt) ?? 0;
        const bTime = this.toEpochMs(b.createdAt) ?? 0;
        return bTime - aTime;
      });
    }

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

  async bulkSave<T>(
    namespace: string,
    records: Array<{ id: string; data: T }>,
  ): Promise<void> {
    const map = this.getNamespaceMap(namespace);
    for (const record of records) {
      map.set(record.id, this.clone(record.data));
    }
  }

  async bulkDelete(namespace: string, ids: string[]): Promise<void> {
    const map = this.getNamespaceMap(namespace);
    for (const id of ids) {
      map.delete(id);
    }
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

  async increment(
    namespace: string,
    id: string,
    field: string,
    by = 1,
  ): Promise<number> {
    const map = this.getNamespaceMap(namespace);
    const existing = this.clone((map.get(id) ?? {}) as Record<string, any>);
    const current = Number(existing[field] ?? 0);
    const next = (Number.isFinite(current) ? current : 0) + by;
    existing[field] = next;
    map.set(id, existing);
    return next;
  }

  async compareAndSet<T extends Record<string, any>>(
    namespace: string,
    id: string,
    expected: Partial<T>,
    patch: Partial<T>,
  ): Promise<boolean> {
    const map = this.getNamespaceMap(namespace);
    const existing = map.get(id);
    if (!existing) return false;
    for (const [key, value] of Object.entries(expected)) {
      if (!this.valuesEqual(existing[key], value)) return false;
    }
    map.set(id, this.clone({ ...existing, ...patch }));
    return true;
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
        case "$lt":
          if (!(a < (b as any))) return false;
          break;
        case "$lte":
          if (!(a <= (b as any))) return false;
          break;
        case "$gt":
          if (!(a > (b as any))) return false;
          break;
        case "$gte":
          if (!(a >= (b as any))) return false;
          break;
        case "$ne":
          if (!(a !== b)) return false;
          break;
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

  private toComparable(
    value: unknown,
    type?: "number" | "date" | "string",
  ): number | string {
    if (type === "number") {
      const n = Number(value);
      return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
    }
    if (type === "date") {
      return this.toEpochMs(value) ?? Number.NEGATIVE_INFINITY;
    }
    if (typeof value === "number") return value;
    const time = this.toEpochMs(value);
    if (time !== undefined) return time;
    return String(value ?? "");
  }

  private valuesEqual(left: unknown, right: unknown): boolean {
    if (left instanceof Date || right instanceof Date) {
      return this.toEpochMs(left) === this.toEpochMs(right);
    }
    return JSON.stringify(left) === JSON.stringify(right);
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
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[key] = this.clone(item, seen);
    }
    return out as T;
  }
}
