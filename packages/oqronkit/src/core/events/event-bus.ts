import { EventEmitter } from "eventemitter3";

export type ChronoEventMap = {
  "job:start": [jobId: string, module: string];
  "job:progress": [jobId: string, value: number];
  "job:success": [jobId: string];
  "job:fail": [jobId: string, error: Error];
  "system:ready": [];
  "system:stop": [];
};

class OqronEventBusClass extends EventEmitter<ChronoEventMap> {
  private static _instance: OqronEventBusClass;
  static getInstance(): OqronEventBusClass {
    if (!OqronEventBusClass._instance) {
      OqronEventBusClass._instance = new OqronEventBusClass();
    }
    return OqronEventBusClass._instance;
  }
}

export const OqronEventBus = OqronEventBusClass.getInstance();
