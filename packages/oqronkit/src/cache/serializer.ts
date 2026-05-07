import { promisify } from "node:util";
import { brotliCompress, brotliDecompress, gunzip, gzip } from "node:zlib";
import type { CacheCompression, CacheConfig } from "./types.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const brotliCompressAsync = promisify(brotliCompress);
const brotliDecompressAsync = promisify(brotliDecompress);

export async function encodeValue<T>(
  value: T,
  config: CacheConfig<T>,
  compression: CacheCompression,
): Promise<{ payload: string; sizeBytes: number; encrypted: boolean }> {
  const raw = config.serialize
    ? config.serialize(value)
    : JSON.stringify(value);
  let buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "utf8");
  const sizeBytes = buffer.byteLength;

  if (config.maxValueBytes && sizeBytes > config.maxValueBytes) {
    throw new Error(
      `[OqronKit:Cache] "${config.name}" value is ${sizeBytes} bytes, above maxValueBytes ${config.maxValueBytes}.`,
    );
  }

  buffer = await compress(buffer, compression);
  let encrypted = false;
  if (config.encryption) {
    buffer = await config.encryption.encrypt(buffer);
    encrypted = true;
  }

  return {
    payload: buffer.toString("base64"),
    sizeBytes,
    encrypted,
  };
}

export async function decodeValue<T>(
  payload: string,
  config: CacheConfig<T>,
  compression: CacheCompression,
  encrypted: boolean,
): Promise<T> {
  let buffer = Buffer.from(payload, "base64");
  if (encrypted) {
    if (!config.encryption) {
      throw new Error(
        `[OqronKit:Cache] "${config.name}" entry is encrypted but no decryption hook is configured.`,
      );
    }
    buffer = Buffer.from(await config.encryption.decrypt(buffer));
  }
  buffer = Buffer.from(await decompress(buffer, compression));
  if (config.deserialize) {
    return config.deserialize(buffer);
  }
  return JSON.parse(buffer.toString("utf8")) as T;
}

async function compress(
  buffer: Buffer,
  compression: CacheCompression,
): Promise<Buffer> {
  switch (compression) {
    case "none":
      return buffer;
    case "gzip":
      return gzipAsync(buffer);
    case "brotli":
      return brotliCompressAsync(buffer);
    case "snappy":
      throw new Error(
        '[OqronKit:Cache] compression "snappy" requires an optional adapter that is not installed in this release.',
      );
  }
}

async function decompress(
  buffer: Buffer,
  compression: CacheCompression,
): Promise<Buffer> {
  switch (compression) {
    case "none":
      return buffer;
    case "gzip":
      return gunzipAsync(buffer);
    case "brotli":
      return brotliDecompressAsync(buffer);
    case "snappy":
      throw new Error(
        '[OqronKit:Cache] compression "snappy" requires an optional adapter that is not installed in this release.',
      );
  }
}
