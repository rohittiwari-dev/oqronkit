import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["cjs", "esm"],
    cjsInterop: true,
    dts: true,
    clean: true,
    sourcemap: true,
    external: [
      "better-sqlite3",
      "cron-parser",
      "eventemitter3",
      "find-up",
      "voltlog-io",
      "zod",
      "rrule",
    ],
    outDir: "dist",
    target: "node18",
    shims: true,
    treeshake: true,
  },
]);
