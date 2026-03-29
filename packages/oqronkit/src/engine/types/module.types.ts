export interface IOqronModule {
  readonly name: string;
  readonly enabled: boolean;
  init(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Manually trigger a schedule/job by name (for admin APIs) */
  triggerManual?(scheduleId: string): Promise<boolean>;
  /** Cancel an actively running job. Returns true if it was found and cancelled. */
  cancelActiveJob?(jobId: string): Promise<boolean>;
}
