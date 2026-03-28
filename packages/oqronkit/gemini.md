# OqronKit Gemini Agent Instructions

You are building the v1 Enterprise Release of OqronKit.
The overarching goal of OqronKit is absolute crash-safety, idempotency, and framework-agnostic backend task processing.

## Core Directives

1. **Guaranteed Execution:**
   - Any module executing a process must support `guaranteedWorker: true`.
   - Implement the Heartbeat Locking mechanism using `ILockAdapter` (default 5s renewals).
   - If a crash occurs, lock TTl expires, and the StallDetector reclaims the job for another worker.

2. **Idempotency Strategy:**
   - State MUST be persisted to the DB adapter *before* execution, and *after* execution.
   - For multi-step architectures (Workflow, Stack, Saga), persist checkpoints between each step.
   - Do NOT assume memory state persists across ticks.

3. **Adapter Interfaces:**
   - Extend existing DB/Lock adapter concepts (`IOqronAdapter`, `ILockAdapter`).
   - For Queues, add an `IQueueAdapter` with primitives like `enqueue`, `claimJobs`, and `completeJob`.
   - Never couple module logic to a specific DB; always execute against the generic interfaces.

4. **Broker Fallback Pattern:**
   - For `pubsub` and `pipeline` modules:
   - Check `config.broker`. If missing, inspect `config.db` or `config.lock` for Redis.
   - If Redis is available, fallback to using it for message streaming natively.
   - If Redis is unavailable and broker is unset, explicitly throw a `OqronModuleInitError`.

## Reference Implementations

When asked to generate a module, refer to the exact API spec defined in `implementation_plan.md` (Queue, Batch, RateLimit, Workflow, Stack, Saga, Pipeline, Webhook, PubSub, Cache).
Match the TS generic typing exactly as outlined in the user examples.

### Example: RateLimit Lua implementation

For distributed features using Redis backend (like sliding-window rate limits):
- Rely on the Redis instance provided through `createLockAdapter()`.
- Use atomic `eval` multi-key scripts (e.g., `ZADD`, `ZCARD`, `ZREMRANGEBYSCORE`).

### Example: Workflow Idempotency

Step executions must automatically recover:
```typescript
async executeStep(runId, stepId) {
  const stepRecord = await db.getStep(runId, stepId);
  if (stepRecord.status === 'completed') return stepRecord.output; // Skip
  // ... execution ...
  await db.updateStep(runId, stepId, { status: 'completed' });
}
```

## Directory Structure
- Place module definition blocks in `src/<module>/types.ts`
- User-facing factory APIs in `src/<module>/define-<module>.ts`
- Engine orchestrators in `src/<module>/<module>-engine.ts` implementing `IOqronModule`
- Dedicated adapters in `src/<module>/<module>-adapters/`

Follow the existing architectural formatting of `src/scheduler` when scaffolding new core features.
