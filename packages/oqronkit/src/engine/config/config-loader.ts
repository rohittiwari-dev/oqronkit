import { pathToFileURL } from "node:url";
import { findUp } from "find-up";
import { reconfigureConfig } from "./default-config.js";
import { OqronConfigSchema, type ValidatedConfig } from "./schema.js";

export async function loadConfig(
  cwd: string = process.cwd(),
): Promise<ValidatedConfig> {
  // Try TypeScript config first, fall back to JS
  const configPath =
    (await findUp("oqron.config.ts", { cwd })) ||
    (await findUp("oqron.config.js", { cwd }));

  if (!configPath) {
    // Return defaults if no config file found
    return OqronConfigSchema.parse({});
  }

  let rawConfig: unknown;
  try {
    // Dynamic import works in Bun for both .ts and .js files
    const mod = await import(/* @vite-ignore */ pathToFileURL(configPath).href);

    // Unwrap nested .default from TSX/CommonJS transpilation
    rawConfig = mod;
    while (
      rawConfig &&
      typeof rawConfig === "object" &&
      "default" in rawConfig
    ) {
      rawConfig = (rawConfig as Record<string, unknown>).default;
    }
  } catch (err) {
    throw new Error(
      `[OqronKit] Failed to load config from: ${configPath}\n${err}`,
    );
  }

  const parseResult = OqronConfigSchema.safeParse(rawConfig);
  if (!parseResult.success) {
    throw new Error(
      `[OqronKit] Invalid oqron.config.ts:\n${parseResult.error.message}`,
    );
  }

  return reconfigureConfig(parseResult.data);
}
