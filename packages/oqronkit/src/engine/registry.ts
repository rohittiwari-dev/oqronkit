import type { IOqronModule } from "./types/module.types.js";

export class OqronRegistry {
  private static _instance: OqronRegistry;
  private readonly _modules = new Map<string, IOqronModule>();

  private constructor() {}

  static getInstance(): OqronRegistry {
    if (!OqronRegistry._instance) {
      OqronRegistry._instance = new OqronRegistry();
    }
    return OqronRegistry._instance;
  }

  register(mod: IOqronModule): void {
    if (this._modules.has(mod.name)) {
      throw new Error(`[OqronKit] Module "${mod.name}" is already registered.`);
    }
    this._modules.set(mod.name, mod);
  }

  get(name: string): IOqronModule | undefined {
    return this._modules.get(name);
  }

  getAll(): IOqronModule[] {
    return [...this._modules.values()];
  }

  /** Reset registry — useful for testing */
  _reset(): void {
    this._modules.clear();
  }
}
