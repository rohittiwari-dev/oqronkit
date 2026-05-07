import { CacheEngine } from "./cache-engine.js";
import { deregisterCache, registerCache } from "./registry.js";
import type { CacheConfig, ICache } from "./types.js";

export const cache = {
  create<T = any>(config: CacheConfig<T>): ICache<T> {
    const engine = new CacheEngine<T>(config);
    registerCache(engine as CacheEngine<any>);
    return engine;
  },

  destroy(name: string): boolean {
    return deregisterCache(name);
  },
};
