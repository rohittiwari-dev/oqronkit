import { EventEmitter } from "eventemitter3";

export type ChronoEventMap = {
  "job:start": [jobId: string, module: string];
  "job:progress": [jobId: string, value: number];
  "job:success": [jobId: string];
  "job:fail": [jobId: string, error: Error];
  "system:ready": [];
  "system:stop": [];
};

class ChronoEventBusClass extends EventEmitter<ChronoEventMap> {
  private static _instance: ChronoEventBusClass;
  static getInstance(): ChronoEventBusClass {
    if (!ChronoEventBusClass._instance) {
      ChronoEventBusClass._instance = new ChronoEventBusClass();
    }
    return ChronoEventBusClass._instance;
  }
}

export const ChronoEventBus = ChronoEventBusClass.getInstance();
