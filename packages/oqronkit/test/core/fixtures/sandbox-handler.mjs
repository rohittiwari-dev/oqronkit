// Test handler for sandboxed processor — returns data with a computed result
export default async function handler(data) {
  return { echo: data, computed: (data.x ?? 0) * 2 };
}

export async function slowHandler(data) {
  await new Promise((r) => setTimeout(r, 60000)); // 60s — will be killed by timeout
  return { result: "should never reach here" };
}

export async function failingHandler(data) {
  throw new Error("handler-explosion");
}
