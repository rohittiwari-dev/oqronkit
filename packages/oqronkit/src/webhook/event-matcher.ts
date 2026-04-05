/**
 * Match an event against glob-style patterns.
 *
 * Segment-aware matching (industry standard):
 *  - `*`  matches a SINGLE segment (no dots):  user.* → user.created ✓,  user.profile.updated ✗
 *  - `**` matches ONE OR MORE segments:          user.** → user.created ✓, user.profile.updated ✓
 *  - Bare `*` or `**` catches everything.
 */
export function matchesEvent(event: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern === event) return true;
    if (pattern === "*" || pattern === "**") return true;

    if (!pattern.includes("*")) return false;

    // Build segment-aware regex
    const regexStr = pattern
      .split(".")
      .map((seg) => {
        if (seg === "**") return ".+"; // multi-segment
        if (seg === "*") return "[^.]+"; // single-segment
        return escapeRegExp(seg);
      })
      .join("\\.");

    return new RegExp(`^${regexStr}$`).test(event);
  });
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
