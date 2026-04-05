import { expect, test, beforeEach, afterEach, vi } from "vitest";
import { OqronKit, queue, queueModule } from "../../src/index.js";
import { OqronRegistry, OqronEventBus } from "../../src/engine/index.js";

beforeEach(async () => {
});

afterEach(async () => {
  await OqronKit.stop();
  OqronRegistry.getInstance()._reset();
});

test("Hook failures don't crash job execution", async () => {
  let hookRan = false;
  const testQueue = queue({
    name: "hook_err_test",
    handler: async () => {
      console.log("HANDLER 1 EXECUTED");
      return "ok";
    },
    hooks: {
      onSuccess: () => {
        console.log("ONSUCCESS HOOK EXECUTED");
        hookRan = true;
        throw new Error("Hook error");
      },
      onFail: () => {
        console.log("ONFAIL HOOK 1 EXECUTED");
      }
    },
  });

  const qMod = queueModule({ heartbeatMs: 100 });
  await OqronKit.init({
    config: { environment: "test", project: "test", modules: [qMod] },
  });

  await testQueue.add({ test: "job1" });
  
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 50));
    if (hookRan) break;
  }

  expect(hookRan).toBe(true);
});

test("onFail hook gets executed on handler error", async () => {
  let hookRan = false;
  const testQueue = queue({
    name: "hook_err_test_2",
    retries: { max: 0 },
    handler: async () => {
      console.log("HANDLER 2 EXECUTED");
      throw new Error("Handler error");
    },
    hooks: {
      onFail: () => {
        console.log("ONFAIL HOOK 2 EXECUTED");
        hookRan = true;
        throw new Error("fail hook error"); // Should not crash processing
      },
    },
  });

  const qMod = queueModule({ heartbeatMs: 100 });
  await OqronKit.init({
    config: { environment: "test", project: "test", modules: [qMod] },
  });

  await testQueue.add({ test: "job2" });
  
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 50));
    if (hookRan) break;
  }

  expect(hookRan).toBe(true);
});
