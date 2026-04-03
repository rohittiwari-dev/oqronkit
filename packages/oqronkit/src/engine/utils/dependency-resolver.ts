import type { IBrokerEngine, ILockAdapter, IStorageEngine } from "../types/engine.js";
import type { OqronJob } from "../types/job.types.js";

/**
 * DependencyResolver — manages parent-child job dependencies.
 *
 * When a job is created with `dependsOn: ["parent-1", "parent-2"]`,
 * it starts in `waiting-children` status. After each parent completes,
 * `notifyChildren()` is called to check if all parents are done.
 * If so, the child is promoted to `waiting` and published to the broker.
 */
export class DependencyResolver {
  /**
   * Check if all parent jobs have completed.
   */
  static async canProceed(
    storage: IStorageEngine,
    dependsOn: string[],
  ): Promise<boolean> {
    for (const parentId of dependsOn) {
      const parent = await storage.get<OqronJob>("jobs", parentId);
      if (!parent || parent.status !== "completed") {
        return false;
      }
    }
    return true;
  }

  /**
   * After a job completes or fails, check all children and:
   * - If parent completed: promote children whose ALL parents are done
   * - If parent failed: apply parentFailurePolicy to children
   */
  static async notifyChildren(
    storage: IStorageEngine,
    broker: IBrokerEngine,
    completedJobId: string,
  ): Promise<void> {
    const completedJob = await storage.get<OqronJob>("jobs", completedJobId);
    if (!completedJob?.childrenIds?.length) return;

    for (const childId of completedJob.childrenIds) {
      const child = await storage.get<OqronJob>("jobs", childId);
      if (!child || child.status !== "waiting-children") continue;

      const dependsOn = child.opts?.dependsOn ?? [];
      const policy = child.opts?.parentFailurePolicy ?? "block";

      // Check if this parent failed
      if (completedJob.status === "failed") {
        if (policy === "cascade-fail") {
          child.status = "failed";
          child.error = `Parent job "${completedJobId}" failed`;
          child.finishedAt = new Date();
          await storage.save("jobs", childId, child);
          // Cascade to this child's children too
          await DependencyResolver.notifyChildren(storage, broker, childId);
          continue;
        }
        if (policy === "block") {
          // Stay in waiting-children — do nothing
          continue;
        }
        // policy === "ignore" — fall through to check other parents
      }

      // Check if ALL parents are done
      let allReady = true;
      for (const parentId of dependsOn) {
        const parent = await storage.get<OqronJob>("jobs", parentId);
        if (!parent) {
          allReady = false;
          break;
        }
        if (parent.status === "completed") {
          continue;
        }
        if (parent.status === "failed" && policy === "ignore") {
          continue;
        }
        allReady = false;
        break;
      }

      if (allReady) {
        child.status = "waiting";
        await storage.save("jobs", childId, child);
        await broker.publish(
          child.queueName,
          childId,
          undefined,
          child.opts?.priority,
        );
      }
    }
  }

  /**
   * Register a child job's dependency on parent jobs.
   * Adds the childId to each parent's childrenIds array.
   *
   * Uses a distributed lock per parent to prevent the read-modify-write
   * race condition where two concurrent workers could overwrite each
   * other's children arrays.
   */
  static async registerDependencies(
    storage: IStorageEngine,
    childId: string,
    dependsOn: string[],
    lock?: ILockAdapter,
  ): Promise<void> {
    const lockOwnerId = `dep-resolver-${childId}`;

    for (const parentId of dependsOn) {
      const lockKey = `dep:parent:${parentId}`;
      let lockAcquired = false;

      // Acquire a short-lived lock to serialize access to parent's childrenIds
      if (lock) {
        for (let attempt = 0; attempt < 3; attempt++) {
          lockAcquired = await lock.acquire(lockKey, lockOwnerId, 5_000);
          if (lockAcquired) break;
          await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
        }
      }

      try {
        const parent = await storage.get<OqronJob>("jobs", parentId);
        if (parent) {
          parent.childrenIds = parent.childrenIds ?? [];
          if (!parent.childrenIds.includes(childId)) {
            parent.childrenIds.push(childId);
          }
          await storage.save("jobs", parentId, parent);
        }
      } finally {
        if (lock && lockAcquired) {
          await lock.release(lockKey, lockOwnerId).catch(() => {});
        }
      }
    }
  }
}

