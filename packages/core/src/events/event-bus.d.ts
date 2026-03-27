import { EventEmitter } from "eventemitter3";
export type ChronoEventMap = {
  "job:start": [jobId: string, module: string];
  "job:progress": [jobId: string, value: number];
  "job:success": [jobId: string];
  "job:fail": [jobId: string, error: Error];
  "system:ready": [];
  "system:stop": [];
};
declare class ChronoEventBusClass extends EventEmitter<ChronoEventMap> {
  private static _instance;
  static getInstance(): ChronoEventBusClass;
}
export declare const ChronoEventBus: ChronoEventBusClass;
//# sourceMappingURL=event-bus.d.ts.map
