import { describe, it, expect } from "vitest";
import { OqronError } from "../../src/core/errors/base.error.js";

describe("OqronError", () => {
  it("is an instance of Error", () => {
    const err = new OqronError("OQRON_TEST", "test message");
    expect(err).toBeInstanceOf(Error);
  });

  it("has correct name, code and message", () => {
    const err = new OqronError("OQRON_TEST", "something failed");
    expect(err.name).toBe("OqronError");
    expect(err.code).toBe("OQRON_TEST");
    expect(err.message).toBe("something failed");
  });

  it("captures a stack trace", () => {
    const err = new OqronError("OQRON_TEST", "stack test");
    expect(err.stack).toBeDefined();
  });
});
