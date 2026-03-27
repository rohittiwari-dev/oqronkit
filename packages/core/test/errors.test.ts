import { describe, it, expect } from "vitest";
import { ChronoError } from "../src/errors/base.error.js";

describe("ChronoError", () => {
  it("is an instance of Error", () => {
    const err = new ChronoError("CHRONO_TEST", "test message");
    expect(err).toBeInstanceOf(Error);
  });

  it("has correct name, code and message", () => {
    const err = new ChronoError("CHRONO_TEST", "something failed");
    expect(err.name).toBe("ChronoError");
    expect(err.code).toBe("CHRONO_TEST");
    expect(err.message).toBe("something failed");
  });

  it("captures a stack trace", () => {
    const err = new ChronoError("CHRONO_TEST", "stack test");
    expect(err.stack).toBeDefined();
  });
});
