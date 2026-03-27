export interface ChronoConfig {
  environment: string;
  db?: {
    type: "sqlite" | "postgres";
    url?: string;
  };
  lock?: {
    type: "db" | "redis";
  };
  logger?: {
    level?: "debug" | "info" | "warn" | "error";
  };
}
//# sourceMappingURL=config.types.d.ts.map
