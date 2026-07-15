import { UsageDomainError } from "./errors.js";

export type CanonicalHasher = (
  canonicalText: string
) => string | Promise<string>;

interface WebCryptoLike {
  readonly subtle: {
    digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer>;
  };
}

const SHA_256_HEX_PATTERN = /^[0-9a-f]{64}$/;

function serializeCanonical(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new UsageDomainError(
        "CANONICALIZATION_FAILED",
        "Canonical JSON cannot contain a non-finite number."
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new UsageDomainError(
      "CANONICALIZATION_FAILED",
      "Canonical JSON contains an unsupported value."
    );
  }
  if (ancestors.has(value)) {
    throw new UsageDomainError(
      "CANONICALIZATION_FAILED",
      "Canonical JSON cannot contain a cycle."
    );
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return (
        "[" +
        Array.from(value, (item) => serializeCanonical(item, ancestors)).join(",") +
        "]"
      );
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new UsageDomainError(
        "CANONICALIZATION_FAILED",
        "Canonical JSON requires plain objects."
      );
    }

    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map(
        (key) =>
          JSON.stringify(key) + ":" + serializeCanonical(record[key], ancestors)
      );
    return "{" + entries.join(",") + "}";
  } finally {
    ancestors.delete(value);
  }
}

/** RFC 8785-compatible serialization for TokenMonster's strict JSON domain. */
export function canonicalizeJson(value: unknown): string {
  return serializeCanonical(value, new Set());
}

export async function webCryptoSha256Hex(
  canonicalText: string
): Promise<string> {
  const cryptoProvider = globalThis.crypto as WebCryptoLike | undefined;
  if (cryptoProvider?.subtle === undefined) {
    throw new UsageDomainError(
      "HASH_UNAVAILABLE",
      "Web Crypto SHA-256 is unavailable in this runtime."
    );
  }

  let digest: ArrayBuffer;
  try {
    digest = await cryptoProvider.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonicalText)
    );
  } catch {
    throw new UsageDomainError(
      "HASH_UNAVAILABLE",
      "Web Crypto SHA-256 failed."
    );
  }

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function hashCanonicalText(
  canonicalText: string,
  hasher: CanonicalHasher = webCryptoSha256Hex
): Promise<string> {
  let hash: string;
  try {
    hash = await hasher(canonicalText);
  } catch (error) {
    if (error instanceof UsageDomainError) throw error;
    throw new UsageDomainError("HASH_UNAVAILABLE", "SHA-256 hashing failed.");
  }
  if (!SHA_256_HEX_PATTERN.test(hash)) {
    throw new UsageDomainError(
      "HASH_INVALID",
      "The SHA-256 hasher returned a non-canonical digest."
    );
  }
  return hash;
}
