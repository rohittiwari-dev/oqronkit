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
  private delayed = new Map<string, { runAt: number; id: string; priority?: number }[]>();
  private activeLocks = new Map<string, LockEntry>(); // brokerName + id -> lock
  private paused = new Set<string>();
  private readonly lockSeparator = "\u0000";

  private lockKey(brokerName: string, id: string): string {
    return `${brokerName}${this.lockSeparator}${id}`;
  }

  private removeQueuedId(brokerName: string, id: string): void {
    const waiting = this.waitLists.get(brokerName);
    if (waiting) {
      this.waitLists.set(
        brokerName,
        waiting.filter((queuedId) => queuedId !== id),
      );
    }

    const priority = this.priorityLists.get(brokerName);
    if (priority) {
      this.priorityLists.set(
        brokerName,
        priority.filter((entry) => entry.id !== id),
      );
    }

    const delayed = this.delayed.get(brokerName);
    if (delayed) {
      this.delayed.set(
        brokerName,
        delayed.filter((entry) => entry.id !== id),
      );
    }
  }

  private nextDelayedDueInMs(brokerName: string): number | null {
    const delayed = this.delayed.get(brokerName) || [];
    if (delayed.length === 0) return null;
    const nextRunAt = Math.min(...delayed.map((entry) => entry.runAt));
    return Math.max(0, nextRunAt - Date.now());
  }

  private scheduleDelayedWake(brokerName: string, delayMs: number): void {
    const timer = setTimeout(() => {
      this.events.emit(`broker:ready:${brokerName}`);
    }, Math.max(0, delayMs));
    timer.unref();
  }

  async publish(
    brokerName: string,
    id: string,
    delayMs?: number,
    priority?: number,
  ): Promise<void> {
    this.removeQueuedId(brokerName, id);
    if (delayMs && delayMs > 0) {
      const list = this.delayed.get(brokerName) || [];
      list.push({ runAt: Date.now() + delayMs, id, priority });
      this.delayed.set(brokerName, list);
      this.scheduleDelayedWake(brokerName, delayMs);
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

    // 0. Evict expired locks to prevent memory leaks from crashed workers
    for (const [cid, lock] of this.activeLocks.entries()) {
      if (lock.expiresAt < now) {
        this.activeLocks.delete(cid);
      }
    }

    // 1. Promote due delayed items (MB1: restore original priority)
    const delayed = this.delayed.get(brokerName) || [];
    const due = delayed.filter((d) => d.runAt <= now);
    if (due.length > 0) {
      if (strategy === "priority") {
        const pList = this.priorityLists.get(brokerName) || [];
        for (const d of due) pList.push({ id: d.id, priority: d.priority ?? 0 });
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
      this.activeLocks.set(this.lockKey(brokerName, cid), {
        consumerId,
        expiresAt: now + lockTtlMs,
      });
    }

    return claimedIds;
  }

  async extendLock(
    id: string,
    consumerId: string,
    lockTtlMs: number,
  ): Promise<void> {
    let matchingKey: string | undefined;
    let lock: LockEntry | undefined;
    for (const [key, candidate] of this.activeLocks.entries()) {
      const candidateId = key.slice(key.indexOf(this.lockSeparator) + 1);
      if (candidateId !== id || candidate.consumerId !== consumerId) continue;
      if (matchingKey) {
        throw new Error(`Ambiguous lock for entity ${id}; broker name is required`);
      }
      matchingKey = key;
      lock = candidate;
    }
    const now = Date.now();

    // Explicit expiration check: if lock naturally expired, delete it and reject extension
    if (matchingKey && lock && lock.expiresAt < now) {
      this.activeLocks.delete(matchingKey);
      lock = undefined;
    }

    const currentLock = matchingKey ? this.activeLocks.get(matchingKey) : undefined;
    if (!currentLock || currentLock.consumerId !== consumerId) {
      throw new Error(`Lock lost or stolen for entity ${id}`);
    }

    currentLock.expiresAt = now + lockTtlMs;
  }

  async ack(brokerName: string, id: string): Promise<void> {
    this.activeLocks.delete(this.lockKey(brokerName, id));
    this.removeQueuedId(brokerName, id);
  }

  async nack(
    brokerName: string,
    id: string,
    delayMs?: number,
    priority?: number,
  ): Promise<void> {
    this.activeLocks.delete(this.lockKey(brokerName, id));
    this.removeQueuedId(brokerName, id);

    if (delayMs && delayMs > 0) {
      const list = this.delayed.get(brokerName) || [];
      list.push({ runAt: Date.now() + delayMs, id, priority });
      this.delayed.set(brokerName, list);
      this.scheduleDelayedWake(brokerName, delayMs);
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

  /**
   * Blocking claim — waits up to `timeoutMs` for a job to become available.
   * Uses EventEmitter-based notification (zero CPU while waiting).
   */
  async claimBlocking(
    brokerName: string,
    consumerId: string,
    lockTtlMs: number,
    timeoutMs: number,
    strategy: BrokerStrategy = "fifo",
  ): Promise<string | null> {
    // Try non-blocking first
    const immediate = await this.claim(brokerName, consumerId, 1, lockTtlMs, strategy);
    if (immediate.length > 0) return immediate[0];

    // Wait for a job to arrive or timeout
    return new Promise<string | null>((resolve) => {
      let settled = false;
      const eventName = `broker:ready:${brokerName}`;
      let dueTimer: ReturnType<typeof setTimeout> | undefined;

      const timeoutTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (dueTimer) clearTimeout(dueTimer);
        this.events.removeListener(eventName, onReady);
        resolve(null);
      }, timeoutMs);
      timeoutTimer.unref();

      const onReady = async () => {
        if (settled) return;
        const claimed = await this.claim(brokerName, consumerId, 1, lockTtlMs, strategy);
        if (claimed.length > 0) {
          settled = true;
          clearTimeout(timeoutTimer);
          if (dueTimer) clearTimeout(dueTimer);
          this.events.removeListener(eventName, onReady);
          resolve(claimed[0]);
        }
      };

      const dueInMs = this.nextDelayedDueInMs(brokerName);
      if (dueInMs !== null && dueInMs <= timeoutMs) {
        dueTimer = setTimeout(() => void onReady(), dueInMs);
        dueTimer.unref();
      }

      this.events.on(eventName, onReady);
    });
  }
}
