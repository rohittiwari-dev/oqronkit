import { describe, it, expect } from "vitest";
import * as core from "../src/index.js";

describe("@chronoforge/core — Index Exports", () => {
  it("exports ChronoError", () => expect(core.ChronoError).toBeDefined());
  it("exports CronContext", () => expect(core.CronContext).toBeDefined());
  it("exports JobContext", () => expect(core.JobContext).toBeDefined());
  it("exports createLogger", () => expect(core.createLogger).toBeDefined());
  it("exports ChronoEventBus", () => expect(core.ChronoEventBus).toBeDefined());
  it("exports ChronoRegistry", () => expect(core.ChronoRegistry).toBeDefined());
  it("exports ChronoConfigSchema", () => expect(core.ChronoConfigSchema).toBeDefined());
  it("exports defineConfig", () => expect(core.defineConfig).toBeDefined());
  it("exports loadConfig", () => expect(core.loadConfig).toBeDefined());
});
