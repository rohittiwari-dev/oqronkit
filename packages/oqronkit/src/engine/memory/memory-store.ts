import type { IStorageEngine } from "../types/engine.js";

/**
 * Memory-based implementation of the Storage Engine.
 * Used automatically when no Redis URL is provided.
 * Data is structurally mapped to mimic Redis namespaces.
 *
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

  async list<T>(namespace: string, filter?: Record<string, any>): Promise<T[]> {
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

    // Attempt to sort by createdAt if it exists (very common for job structures)
    results.sort((a: any, b: any) => {
      const aTime = a.createdAt?.getTime?.() ?? 0;
      const bTime = b.createdAt?.getTime?.() ?? 0;
      return bTime - aTime; // descending
    });

    return results;
  }

  async delete(namespace: string, id: string): Promise<void> {
    const map = this.getNamespaceMap(namespace);
    map.delete(id);
  }

  async prune(namespace: string, beforeMs: number): Promise<number> {
    const map = this.getNamespaceMap(namespace);
    let prunedCount = 0;

    for (const [id, value] of map.entries()) {
      const createdAt = value?.createdAt?.getTime?.() ?? value?.createdAt;
      // If we clearly exceed retention threshold, or it's very old:
      if (typeof createdAt === "number" && createdAt < beforeMs) {
        map.delete(id);
        prunedCount++;
      }
    }

    return prunedCount;
  }
}
