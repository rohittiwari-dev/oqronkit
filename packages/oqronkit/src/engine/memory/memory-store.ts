import type { IStorageEngine, ListOptions } from "../types/engine.js";

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
    map.set(id, { ...data }); // Clone to prevent mutation refs
  }

  async get<T>(namespace: string, id: string): Promise<T | null> {
    const map = this.getNamespaceMap(namespace);
    const data = map.get(id);
    return data ? { ...data } : null;
  }

  async list<T>(
    namespace: string,
    filter?: Record<string, any>,
    opts?: ListOptions,
  ): Promise<T[]> {
    const map = this.getNamespaceMap(namespace);
    let results: T[] = Array.from(map.values()) as T[];

    if (filter) {
      results = results.filter((item: any) => {
        for (const [key, val] of Object.entries(filter)) {
          if (item[key] !== val) return false;
        }
        return true;
      });
    }

    // Sort by createdAt descending (newest first)
    results.sort((a: any, b: any) => {
      const aTime = a.createdAt?.getTime?.() ?? 0;
      const bTime = b.createdAt?.getTime?.() ?? 0;
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
      for (const [key, val] of Object.entries(filter)) {
        if (item[key] !== val) {
          matches = false;
          break;
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
}
