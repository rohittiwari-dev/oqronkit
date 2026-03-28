import { pathToFileURL } from "node:url";
import { findUp } from "find-up";
import { ChronoConfigSchema, type ValidatedConfig } from "./schema.js";

export async function loadConfig(
  cwd: string = process.cwd(),
): Promise<ValidatedConfig> {
  // Try TypeScript config first, fall back to JS
  const configPath =
    (await findUp("cnforge.config.ts", { cwd })) ||
    (await findUp("cnforge.config.js", { cwd }));

  if (!configPath) {
    // Return defaults if no config file found
    return ChronoConfigSchema.parse({});
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
      rawConfig = (rawConfig as any).default;
    }
  } catch (err) {
    throw new Error(
      `[ChronoForge] Failed to load config from: ${configPath}\n${err}`,
    );
  }

  const parseResult = ChronoConfigSchema.safeParse(rawConfig);
  if (!parseResult.success) {
    throw new Error(
      `[ChronoForge] Invalid cnforge.config.ts:\n${parseResult.error.message}`,
    );
  }

  return parseResult.data;
}
