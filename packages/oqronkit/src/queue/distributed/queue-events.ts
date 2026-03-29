import { EventEmitter } from "eventemitter3";
import { OqronEventBus, Storage } from "../../engine/index.js";
import type { IBrokerEngine } from "../../engine/types/engine.js";

export interface QueueEventsOptions {
  connection?: IBrokerEngine;
}

export type QueueEventsMap = {
  active: [{ jobId: string; prev?: string }];
  progress: [{ jobId: string; data: number | string }];
  completed: [{ jobId: string; returnvalue?: any; prev?: string }];
  failed: [{ jobId: string; failedReason: string; prev?: string }];
};

/**
 * Enterprise Observability stream decoupled from CPU Workers.
 * Filters global telemetric bus payloads dynamically for an isolated Queue.
 */
export class QueueEvents extends EventEmitter<QueueEventsMap> {
  // Store refs directly so we can cleanly close Native EventListeners on teardown
  private startListener = this._handleStart.bind(this);
  private progressListener = this._handleProgress.bind(this);
  private successListener = this._handleSuccess.bind(this);
  private errorListener = this._handleError.bind(this);

  constructor(
    public readonly name: string,
    _options?: QueueEventsOptions,
  ) {
    super();

    // In a fully deployed Redis setup, `options.connection` parses Redis streams directly.
    // In our abstract layer, we bind securely to the OqronKit global pubsub bus.
    OqronEventBus.on("job:start", this.startListener);
    OqronEventBus.on("job:progress", this.progressListener);
    OqronEventBus.on("job:success", this.successListener);
    OqronEventBus.on("job:fail", this.errorListener);
  }

  // -------------------------
  // Handlers mapping generic globals to strict QueueEvents bounds
  // -------------------------
  private _handleStart(queueName: string, jobId: string) {
    if (queueName === this.name) {
      this.emit("active", { jobId, prev: "waiting" });
    }
  }

  private _handleProgress(queueName: string, jobId: string, value: number) {
    if (queueName === this.name) {
      this.emit("progress", { jobId, data: value });
    }
  }

  private async _handleSuccess(queueName: string, jobId: string) {
    if (queueName === this.name) {
      try {
        const job = await Storage.get<any>("jobs", jobId);
        this.emit("completed", {
          jobId,
          returnvalue: job?.returnValue,
          prev: "active",
        });
      } catch {
        this.emit("completed", { jobId, prev: "active" });
      }
    }
  }

  private _handleError(queueName: string, jobId: string, error: Error) {
    if (queueName === this.name) {
      this.emit("failed", {
        jobId,
        failedReason: error.message,
        prev: "active",
      });
    }
  }

  /** Removes background listener instances securing against memory limits when dynamically constructing/destroying streams */
  close() {
    OqronEventBus.off("job:start", this.startListener);
    OqronEventBus.off("job:progress", this.progressListener);
    OqronEventBus.off("job:success", this.successListener);
    OqronEventBus.off("job:fail", this.errorListener);
  }
}
