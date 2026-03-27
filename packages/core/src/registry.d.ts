import type { IChronoModule } from "./types/module.types.js";
export declare class ChronoRegistry {
  private static _instance;
  private readonly _modules;
  private constructor();
  static getInstance(): ChronoRegistry;
  register(mod: IChronoModule): void;
  get(name: string): IChronoModule | undefined;
  getAll(): IChronoModule[];
  /** Reset registry — useful for testing */
  _reset(): void;
}
//# sourceMappingURL=registry.d.ts.map
