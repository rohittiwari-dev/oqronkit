interface LruEntry<T> {
  value: T;
  sizeBytes: number;
}

export class LruCache<T> {
  private readonly map = new Map<string, LruEntry<T>>();

  constructor(private readonly maxItems: number) {}

  get size(): number {
    return this.map.size;
  }

  get approxBytes(): number {
    let total = 0;
    for (const entry of this.map.values()) total += entry.sizeBytes;
    return total;
  }

  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, sizeBytes = 0): string[] {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, sizeBytes });

    const evicted: string[] = [];
    while (this.map.size > this.maxItems) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
      evicted.push(oldest);
    }
    return evicted;
  }

  delete(key: string): boolean {
    return this.map.delete(key);
  }

  clear(): number {
    const count = this.map.size;
    this.map.clear();
    return count;
  }

  keys(): string[] {
    return [...this.map.keys()];
  }

  entries(): Array<[string, T]> {
    return [...this.map.entries()].map(([key, entry]) => [key, entry.value]);
  }
}
