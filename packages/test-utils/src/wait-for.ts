export const waitFor = async <T>(
  condition: () => Promise<T> | T,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<T> => {
  const timeoutMs = options?.timeoutMs ?? 5000;
  const intervalMs = options?.intervalMs ?? 50;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const result = await condition();
    if (result) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor timed out");
};
