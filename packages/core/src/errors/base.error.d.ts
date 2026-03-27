export declare class ChronoError extends Error {
  readonly code: string;
  readonly context?: Record<string, unknown> | undefined;
  readonly cause?: Error | undefined;
  constructor(
    code: string,
    message: string,
    context?: Record<string, unknown> | undefined,
    cause?: Error | undefined,
  );
  toJSON(): {
    name: string;
    code: string;
    message: string;
    context: Record<string, unknown> | undefined;
  };
}
//# sourceMappingURL=base.error.d.ts.map
