import { describe, it, expect } from "vitest";
import * as core from "../../src/core/index.js";

describe("../../../src/core/core/index.js — Index Exports", () => {
  it("exports ChronoError", () => expect(core.ChronoError).toBeDefined());
  it("exports CronContext", () => expect(core.CronContext).toBeDefined());
  it("exports JobContext", () => expect(core.JobContext).toBeDefined());
  it("exports createLogger", () => expect(core.createLogger).toBeDefined());
  it("exports OqronEventBus", () => expect(core.OqronEventBus).toBeDefined());
  it("exports OqronRegistry", () => expect(core.OqronRegistry).toBeDefined());
  it("exports OqronConfigSchema", () => expect(core.OqronConfigSchema).toBeDefined());
  it("exports defineConfig", () => expect(core.defineConfig).toBeDefined());
  it("exports loadConfig", () => expect(core.loadConfig).toBeDefined());
});
