import { EventEmitter } from "eventemitter3";
import type { BrokerStrategy, IBrokerEngine } from "../types/engine.js";

interface LockEntry {
  consumerId: string;
  expiresAt: number;
}

interface PriorityEntry {
  id: string;
  priority: number;
}

export class MemoryBroker implements IBrokerEngine {
  private events = new EventEmitter();
  private waitLists = new Map<string, string[]>(); // FIFO/LIFO queue
  private priorityLists = new Map<string, PriorityEntry[]>(); // Priority queue
  private delayed = new Map<string, { runAt: number; id: string }[]>();
  private activeLocks = new Map<string, LockEntry>(); // id -> lock
  private paused = new Set<string>();

  async publish(
    brokerName: string,
    id: string,
    delayMs?: number,
    priority?: number,
  ): Promise<void> {
    if (delayMs && delayMs > 0) {
      const list = this.delayed.get(brokerName) || [];
      list.push({ runAt: Date.now() + delayMs, id });
      this.delayed.set(brokerName, list);
    } else if (priority !== undefined) {
      // Priority: insert into sorted priority list
      const list = this.priorityLists.get(brokerName) || [];
      list.push({ id, priority });
      // Sort: lower number = higher priority (runs first)
      list.sort((a, b) => a.priority - b.priority);
      this.priorityLists.set(brokerName, list);
      this.events.emit(`broker:ready:${brokerName}`);
    } else {
      const list = this.waitLists.get(brokerName) || [];
      list.push(id);
      this.waitLists.set(brokerName, list);
      this.events.emit(`broker:ready:${brokerName}`);
    }
  }

  async claim(
    brokerName: string,
    consumerId: string,
    limit: number,
    lockTtlMs: number,
    strategy: BrokerStrategy = "fifo",
  ): Promise<string[]> {
    if (this.paused.has(brokerName)) return [];

    const now = Date.now();

    // 1. Promote due delayed items
    const delayed = this.delayed.get(brokerName) || [];
    const due = delayed.filter((d) => d.runAt <= now);
    if (due.length > 0) {
      if (strategy === "priority") {
        const pList = this.priorityLists.get(brokerName) || [];
        for (const d of due) pList.push({ id: d.id, priority: 0 }); // default priority
        pList.sort((a, b) => a.priority - b.priority);
        this.priorityLists.set(brokerName, pList);
      } else {
        const waiting = this.waitLists.get(brokerName) || [];
        for (const d of due) waiting.push(d.id);
        this.waitLists.set(brokerName, waiting);
      }
      this.delayed.set(
        brokerName,
        delayed.filter((d) => d.runAt > now),
      );
    }

    // 2. Claim based on strategy
    let claimedIds: string[];

    if (strategy === "priority") {
      const pList = this.priorityLists.get(brokerName) || [];
      if (pList.length === 0) return [];
      claimedIds = pList.splice(0, limit).map((e) => e.id);
      this.priorityLists.set(brokerName, pList);
    } else if (strategy === "lifo") {
      const waiting = this.waitLists.get(brokerName) || [];
      if (waiting.length === 0) return [];
      // LIFO: pop from the end (most recently added)
      claimedIds = [];
      for (let i = 0; i < limit && waiting.length > 0; i++) {
        claimedIds.push(waiting.pop()!);
      }
      this.waitLists.set(brokerName, waiting);
    } else {
      // FIFO: splice from the front (oldest first) — default
      const waiting = this.waitLists.get(brokerName) || [];
      if (waiting.length === 0) return [];
      claimedIds = waiting.splice(0, limit);
      this.waitLists.set(brokerName, waiting);
    }

    // 3. Atomically lock them
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
    this.activeLocks.delete(id);
  }

  async nack(brokerName: string, id: string, delayMs?: number): Promise<void> {
    this.activeLocks.delete(id);

    if (delayMs && delayMs > 0) {
      const list = this.delayed.get(brokerName) || [];
      list.push({ runAt: Date.now() + delayMs, id });
      this.delayed.set(brokerName, list);
    } else {
      const waiting = this.waitLists.get(brokerName) || [];
      waiting.unshift(id);
      this.waitLists.set(brokerName, waiting);
      this.events.emit(`broker:ready:${brokerName}`);
    }
  }

  async pause(brokerName: string): Promise<void> {
    this.paused.add(brokerName);
  }

  async resume(brokerName: string): Promise<void> {
    this.paused.delete(brokerName);
    this.events.emit(`broker:ready:${brokerName}`);
  }
}
