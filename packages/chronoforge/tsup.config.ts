import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["cjs", "esm"],
    dts: true,
    clean: true,
    sourcemap: false,
    external: ["better-sqlite3", "cron-parser", "eventemitter3", "find-up", "voltlog-io", "zod"],
    outDir: "dist",
    target: "node18",
    shims: true,
    treeshake: true,
  },
  // Isolated sub-module exports
  {
    entry: {
      cron: "src/cron.ts",
      scheduler: "src/scheduler/index.ts"
    },
    format: ["cjs", "esm"],
    dts: true,
    clean: false,
    sourcemap: false,
    external: ["eventemitter3", "zod", "cron-parser", "better-sqlite3"],
    outDir: "dist",
    target: "node18",
    shims: true,
    treeshake: true,
  },
]);
