import { cronParser } from "./cron-compat.js";

export function getNextRunDate(
  expression: string,
  timezone?: string,
  from = new Date(),
): Date {
  const opts: { currentDate: Date; tz?: string } = { currentDate: from };
  if (timezone) opts.tz = timezone;
  return cronParser.parseExpression(expression, opts).next().toDate();
}
