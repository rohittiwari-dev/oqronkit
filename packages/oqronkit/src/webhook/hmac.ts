import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Generate a signature for a webhook payload.
 * Supports custom sign functions to override the built-in OqronKit HMAC.
 */
export async function signWebhookPayload(
  body: string,
  secret: string,
  timestamp: number,
  algorithm: "sha256" | "sha512" = "sha256",
  customSignFunction?: (
    body: string,
    secret: string,
    timestamp: number,
  ) => string | Promise<string>,
): Promise<string> {
  if (customSignFunction) {
    return await customSignFunction(body, secret, timestamp);
  }

  const payloadToSign = `${timestamp}.${body}`;
  const hmac = createHmac(algorithm, secret);
  hmac.update(payloadToSign, "utf8");
  const signature = hmac.digest("hex");

  return `t=${timestamp},v1=${signature}`;
}

export function verifyWebhookSignature(
  signatureHeader: string,
  body: string,
  secret: string,
  algorithm: "sha256" | "sha512" = "sha256",
  toleranceMs: number = 300000, // 5 minutes defaults
): boolean {
  const parts = signatureHeader.split(",");
  let timestampStr = "";
  let v1Sig = "";

  for (const part of parts) {
    if (part.startsWith("t=")) timestampStr = part.slice(2);
    if (part.startsWith("v1=")) v1Sig = part.slice(3);
  }

  if (!timestampStr || !v1Sig) return false;

  const timestamp = parseInt(timestampStr, 10);
  if (Number.isNaN(timestamp)) return false;
  if (Date.now() - timestamp > toleranceMs) return false;

  const payloadToSign = `${timestamp}.${body}`;
  const hmac = createHmac(algorithm, secret);
  hmac.update(payloadToSign, "utf8");
  const expectedSignature = hmac.digest("hex");

  try {
    const expectedBuffer = Buffer.from(expectedSignature, "hex");
    const actualBuffer = Buffer.from(v1Sig, "hex");
    if (expectedBuffer.length !== actualBuffer.length) return false;
    return timingSafeEqual(expectedBuffer, actualBuffer);
  } catch {
    return false;
  }
}
