import _cronParser from "cron-parser";

/**
 * Ensures 'cron-parser' loads correctly across both CommonJS and ECMAScript modules,
 * resolving bundling edge cases caused by interop wrappers (e.g. tsup/rollup).
 *
 * The type-safe check avoids relying on `(x as any).default` which can silently
 * break when bundler output changes.
 */
function resolveCronParser(): typeof _cronParser {
  const mod = _cronParser as Record<string, unknown>;
  if (
    typeof mod === "object" &&
    mod !== null &&
    "default" in mod &&
    typeof mod.default === "object" &&
    mod.default !== null &&
    "parseExpression" in (mod.default as Record<string, unknown>)
  ) {
    return mod.default as typeof _cronParser;
  }
  return _cronParser;
}

export const cronParser = resolveCronParser();
