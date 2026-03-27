export interface IChronoModule {
  readonly name: string;
  readonly enabled: boolean;
  init(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
//# sourceMappingURL=module.types.d.ts.map
