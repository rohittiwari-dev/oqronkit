import type { WebhookDeliveryResult } from "./types.js";

/**
 * Deliver a webhook via native Node fetch.
 * Captures full status, headers, and body for telemetry (up to maxBodyBytes).
 */
export async function deliverWebhook(
  url: string,
  method: string,
  headers: Record<string, string>,
  bodyStr: string,
  timeoutMs: number = 30000,
  maxBodyBytes: number = 65536, // 64KB max response body capture
): Promise<WebhookDeliveryResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const start = performance.now();

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: bodyStr,
      signal: controller.signal,
    });

    const durationMs = Math.round(performance.now() - start);

    // Capture response headers
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    // Capture response body (safe truncation)
    let bodyText = "";
    if (response.body) {
      try {
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        if (buffer.length > maxBodyBytes) {
          bodyText =
            buffer.subarray(0, maxBodyBytes).toString("utf8") +
            "\n...[TRUNCATED]";
        } else {
          bodyText = buffer.toString("utf8");
        }
      } catch (e: any) {
        bodyText = `[Failed to parse response body: ${e.message}]`;
      }
    }

    // G6: Parse Retry-After header (429/503) — supports seconds and HTTP-date
    let retryAfterMs: number | undefined;
    const retryAfterRaw = response.headers.get("retry-after");
    if (retryAfterRaw && (response.status === 429 || response.status === 503)) {
      const seconds = Number(retryAfterRaw);
      if (!Number.isNaN(seconds)) {
        retryAfterMs = Math.round(seconds * 1000);
      } else {
        // Try HTTP-date format: "Wed, 01 May 2026 12:00:00 GMT"
        const date = new Date(retryAfterRaw);
        if (!Number.isNaN(date.getTime())) {
          retryAfterMs = Math.max(0, date.getTime() - Date.now());
        }
      }
    }

    return {
      status: response.status,
      headers: responseHeaders,
      body: bodyText || null,
      durationMs,
      retryAfterMs,
    };
  } catch (error: any) {
    const durationMs = Math.round(performance.now() - start);

    // Check if it's an abort error
    if (error.name === "AbortError") {
      throw new Error(`Webhook delivery timeout after ${timeoutMs}ms`);
    }

    throw new Error(
      `Webhook delivery failed: ${error.message} (Duration: ${durationMs}ms)`,
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Determine if an HTTP status or error should trigger a retry.
 */
export function shouldRetryDelivery(
  statusOrError?: number | Error,
  customRetryStatusCodes?: number[],
): boolean {
  if (statusOrError instanceof Error) {
    // Network errors, timeouts, resets should be retried
    return true;
  }

  const status = statusOrError;
  if (!status) return false;

  if (customRetryStatusCodes && customRetryStatusCodes.length > 0) {
    return customRetryStatusCodes.includes(status);
  }

  // Default: Retry 5xx and 429 Too Many Requests
  return status >= 500 || status === 429;
}
