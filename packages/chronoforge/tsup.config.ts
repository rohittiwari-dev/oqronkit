import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["cjs", "esm"],
    dts: false,
    splitting: false,
    sourcemap: false,
    clean: true,
    outDir: "dist",
    target: "node18",
    shims: true,
    treeshake: true,
    external: ["@chronoforge/core", "@chronoforge/db", "@chronoforge/lock", "@chronoforge/scheduler"],
  },
  {
    entry: { cron: "src/cron.ts" },
    format: ["cjs", "esm"],
    dts: false,
    splitting: false,
    sourcemap: false,
    clean: false,
    outDir: "dist",
    target: "node18",
    shims: true,
    treeshake: true,
    external: ["@chronoforge/core", "@chronoforge/scheduler"],
  },
]);
