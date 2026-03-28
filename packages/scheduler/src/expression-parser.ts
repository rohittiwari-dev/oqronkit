// cron-parser is a CJS module. When bundled for ESM by tsup,
// the actual exports land on `.default`. This helper handles both paths.
import _cronParser from "cron-parser";

const cronParser = (_cronParser as any).default ?? _cronParser;

export function getNextRunDate(
  expression: string,
  timezone?: string,
  from = new Date(),
): Date {
  const opts: { currentDate: Date; tz?: string } = { currentDate: from };
  if (timezone) opts.tz = timezone;
  return cronParser.parseExpression(expression, opts).next().toDate();
}
