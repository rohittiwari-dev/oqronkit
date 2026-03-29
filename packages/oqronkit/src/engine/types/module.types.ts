export interface IOqronModule {
  readonly name: string;
  readonly enabled: boolean;
  init(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Manually trigger a schedule/job by name (for admin APIs) */
  triggerManual?(scheduleId: string): Promise<boolean>;
}
