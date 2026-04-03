import { expect, test, vi } from "vitest";
import { StallDetector } from "../../src/engine/lock/stall-detector.js";
import type { Logger } from "../../src/engine/logger/index.js";
import type { ILockAdapter } from "../../src/engine/types/engine.js";

test("StallDetector triggers onStalled when lock is lost", async () => {
  vi.useFakeTimers();

  const mockLock: ILockAdapter = {
    acquire: vi.fn(),
    release: vi.fn(),
    extend: vi.fn(),
    isOwner: vi.fn().mockResolvedValue(false),
  };

  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const detector = new StallDetector(mockLock, logger, 100);
  
  const onStalled = vi.fn();
  
  detector.start(
    () => [{ key: "test_job_1", ownerId: "worker-1" }],
    onStalled
  );

  await vi.advanceTimersByTimeAsync(150);

  expect(mockLock.isOwner).toHaveBeenCalledWith("test_job_1", "worker-1");
  expect(onStalled).toHaveBeenCalledWith("test_job_1");
  expect(logger.warn).toHaveBeenCalled();

  detector.stop();
  vi.useRealTimers();
});
