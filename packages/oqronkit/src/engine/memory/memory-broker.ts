import { EventEmitter } from "eventemitter3";
import type { IBrokerEngine } from "../types/engine.js";

interface LockEntry {
  consumerId: string;
  expiresAt: number;
}

export class MemoryBroker implements IBrokerEngine {
  private events = new EventEmitter();
  private waitLists = new Map<string, string[]>(); // brokerName -> id[]
  private delayed = new Map<string, { runAt: number; id: string }[]>(); // brokerName -> {runAt, id}[]
  private activeLocks = new Map<string, LockEntry>(); // id -> lock
  private paused = new Set<string>(); // brokerName

  async publish(
    brokerName: string,
    id: string,
    delayMs?: number,
  ): Promise<void> {
    if (delayMs && delayMs > 0) {
      const list = this.delayed.get(brokerName) || [];
      list.push({ runAt: Date.now() + delayMs, id });
      this.delayed.set(brokerName, list);
    } else {
      const list = this.waitLists.get(brokerName) || [];
      list.push(id);
      this.waitLists.set(brokerName, list);
      // Signal consumers listening
      this.events.emit(`broker:ready:${brokerName}`);
    }
  }

  async claim(
    brokerName: string,
    consumerId: string,
    limit: number,
    lockTtlMs: number,
  ): Promise<string[]> {
    if (this.paused.has(brokerName)) return [];

    const now = Date.now();

    // 1. Promote due delayed items to waiting list
    const delayed = this.delayed.get(brokerName) || [];
    const due = delayed.filter((d) => d.runAt <= now);
    if (due.length > 0) {
      const waiting = this.waitLists.get(brokerName) || [];
      for (const d of due) waiting.push(d.id);
      this.waitLists.set(brokerName, waiting);
      this.delayed.set(
        brokerName,
        delayed.filter((d) => d.runAt > now),
      );
    }

    // 2. Claim from waiting list
    const waiting = this.waitLists.get(brokerName) || [];
    if (waiting.length === 0) return [];

    // Take up to `limit` items
    const claimedIds = waiting.splice(0, limit);
    this.waitLists.set(brokerName, waiting);

    // 3. Atomically lock them for this consumer
    for (const cid of claimedIds) {
      this.activeLocks.set(cid, { consumerId, expiresAt: now + lockTtlMs });
    }

    return claimedIds;
  }

  async extendLock(
    id: string,
    consumerId: string,
    lockTtlMs: number,
  ): Promise<void> {
    const lock = this.activeLocks.get(id);
    if (!lock || lock.consumerId !== consumerId) {
      throw new Error(`Lock lost or stolen for entity ${id}`);
    }
    lock.expiresAt = Date.now() + lockTtlMs;
  }

  async ack(_brokerName: string, id: string): Promise<void> {
    // Acknowledge completely removes the entity from locking pool
    this.activeLocks.delete(id);
  }

  async pause(brokerName: string): Promise<void> {
    this.paused.add(brokerName);
  }

  async resume(brokerName: string): Promise<void> {
    this.paused.delete(brokerName);
    this.events.emit(`broker:ready:${brokerName}`);
  }
}
