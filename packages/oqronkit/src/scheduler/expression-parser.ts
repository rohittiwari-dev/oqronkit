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

/**
 * Validates a cron expression. Throws an error if invalid.
 */
export function validateExpression(expression: string): void {
  cronParser.parseExpression(expression);
}

/**
 * Generates the next 10 run times for a cron expression.
 */
export function generateNextRuns(
  expression: string,
  timezone?: string,
  count = 10,
  from = new Date(),
): Date[] {
  const results: Date[] = [];
  const opts: { currentDate: Date; tz?: string } = { currentDate: from };
  if (timezone) opts.tz = timezone;
  const parser = cronParser.parseExpression(expression, opts);

  for (let i = 0; i < count; i++) {
    results.push(parser.next().toDate());
  }

  return results;
}
