import type { IChronoModule } from "./types/module.types.js";

export class ChronoRegistry {
  private static _instance: ChronoRegistry;
  private readonly _modules = new Map<string, IChronoModule>();

  private constructor() {}

  static getInstance(): ChronoRegistry {
    if (!ChronoRegistry._instance) {
      ChronoRegistry._instance = new ChronoRegistry();
    }
    return ChronoRegistry._instance;
  }

  register(mod: IChronoModule): void {
    if (this._modules.has(mod.name)) {
      throw new Error(
        `[ChronoForge] Module "${mod.name}" is already registered.`,
      );
    }
    this._modules.set(mod.name, mod);
  }

  get(name: string): IChronoModule | undefined {
    return this._modules.get(name);
  }

  getAll(): IChronoModule[] {
    return [...this._modules.values()];
  }

  /** Reset registry — useful for testing */
  _reset(): void {
    this._modules.clear();
  }
}
