export interface IOqronModule {
  readonly name: string;
  readonly enabled: boolean;
  init(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
