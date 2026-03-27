import { findUp } from "find-up";

export async function findUpPath(
  filename: string,
  cwd: string,
): Promise<string | undefined> {
  return findUp(filename, { cwd });
}
