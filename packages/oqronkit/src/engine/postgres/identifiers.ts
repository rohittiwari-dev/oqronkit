const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertValidIdentifier(value: string, label: string): string {
  if (!IDENTIFIER_RE.test(value)) {
    throw new Error(
      `[OqronKit:Postgres] Invalid ${label} "${value}". Use letters, numbers, and underscores, and do not start with a number.`,
    );
  }
  return value;
}

export function quoteIdentifier(
  value: string,
  label: string = "identifier",
): string {
  return `"${assertValidIdentifier(value, label)}"`;
}
