import _cronParser from "cron-parser";

/**
 * Ensures 'cron-parser' loads correctly across both CommonJS and ECMAScript modules,
 * resolving bundling edge cases caused by interop wrappers (e.g. tsup/rollup).
 */
export const cronParser = ((_cronParser as any).default ??
  _cronParser) as typeof _cronParser;
