import { decodeCanonicalBase64Url } from "./encoding.js";
import {
  CloudflareAdapterError,
  sanitizeConfigFailure
} from "./errors.js";

export type WebCryptoPort = Pick<Crypto, "getRandomValues" | "subtle">;

export interface SerializedHmacKeyConfig {
  readonly keyId: string;
  /** Canonical unpadded base64url encoding of exactly 32 secret bytes. */
  readonly secret: string;
}

export interface ImportedHmacKey {
  readonly keyId: string;
  readonly key: CryptoKey;
}

const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;

export function asStrictRecord(
  input: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = []
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new CloudflareAdapterError("CONFIG_INVALID");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CloudflareAdapterError("CONFIG_INVALID");
  }
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const keys = Reflect.ownKeys(input);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    requiredKeys.some((key) => !Object.hasOwn(input, key))
  ) {
    throw new CloudflareAdapterError("CONFIG_INVALID");
  }
  return input as Record<string, unknown>;
}

export function parseHmacKeyConfig(
  input: unknown
): SerializedHmacKeyConfig {
  const record = asStrictRecord(input, ["keyId", "secret"]);
  const keyId = record["keyId"];
  const secret = record["secret"];
  if (
    typeof keyId !== "string" ||
    !KEY_ID_PATTERN.test(keyId) ||
    typeof secret !== "string"
  ) {
    throw new CloudflareAdapterError("CONFIG_INVALID");
  }
  const decoded = decodeCanonicalBase64Url(secret, 32);
  if (decoded === null) {
    throw new CloudflareAdapterError("CONFIG_INVALID");
  }
  decoded.fill(0);
  return Object.freeze({ keyId, secret });
}

export function resolveWebCrypto(input?: WebCryptoPort): WebCryptoPort {
  try {
    const candidate = input ?? globalThis.crypto;
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      typeof candidate.getRandomValues !== "function" ||
      typeof candidate.subtle !== "object" ||
      candidate.subtle === null ||
      typeof candidate.subtle.importKey !== "function" ||
      typeof candidate.subtle.sign !== "function" ||
      typeof candidate.subtle.verify !== "function"
    ) {
      throw new CloudflareAdapterError("CRYPTO_UNAVAILABLE");
    }
    return candidate;
  } catch (error: unknown) {
    if (
      error instanceof CloudflareAdapterError &&
      error.code === "CRYPTO_UNAVAILABLE"
    ) {
      throw error;
    }
    throw new CloudflareAdapterError("CRYPTO_UNAVAILABLE");
  }
}

export async function importHmacKey(
  config: SerializedHmacKeyConfig,
  crypto: WebCryptoPort
): Promise<ImportedHmacKey> {
  const bytes = decodeCanonicalBase64Url(config.secret, 32);
  if (bytes === null) {
    throw new CloudflareAdapterError("CONFIG_INVALID");
  }
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      bytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"]
    );
    if (
      key.type !== "secret" ||
      key.extractable ||
      key.algorithm.name !== "HMAC" ||
      !key.usages.includes("sign") ||
      !key.usages.includes("verify")
    ) {
      throw new CloudflareAdapterError("CONFIG_INVALID");
    }
    return Object.freeze({ keyId: config.keyId, key });
  } catch (error: unknown) {
    sanitizeConfigFailure(error);
  } finally {
    bytes.fill(0);
  }
}

export function assertDistinctKeyConfigs(
  configs: readonly SerializedHmacKeyConfig[]
): void {
  const ids = new Set<string>();
  const secrets = new Set<string>();
  for (const config of configs) {
    if (ids.has(config.keyId) || secrets.has(config.secret)) {
      throw new CloudflareAdapterError("CONFIG_INVALID");
    }
    ids.add(config.keyId);
    secrets.add(config.secret);
  }
}
