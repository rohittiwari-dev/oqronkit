import { EventEmitter } from "eventemitter3";

export type OqronEventMap = {
  "job:start": [queueName: string, jobId: string, module: string];
  "job:progress": [queueName: string, jobId: string, value: number];
  "job:success": [queueName: string, jobId: string];
  "job:fail": [queueName: string, jobId: string, error: Error];
  "system:ready": [];
  "system:stop": [];
};

class OqronEventBusClass extends EventEmitter<OqronEventMap> {
  private static _instance: OqronEventBusClass;
  static getInstance(): OqronEventBusClass {
    if (!OqronEventBusClass._instance) {
      OqronEventBusClass._instance = new OqronEventBusClass();
    }
    return OqronEventBusClass._instance;
  }
}

export const OqronEventBus = OqronEventBusClass.getInstance();
