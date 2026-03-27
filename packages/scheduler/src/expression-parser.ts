import * as cronParser from "cron-parser";

export function getNextRunDate(
  expression: string,
  timezone?: string,
  from = new Date(),
): Date {
  const opts: cronParser.ParserOptions = { currentDate: from };
  if (timezone) opts.tz = timezone;
  return cronParser.parseExpression(expression, opts).next().toDate();
}
