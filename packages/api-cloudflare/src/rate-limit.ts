import {
  asStrictRecord,
  assertDistinctKeyConfigs,
  importHmacKey,
  parseHmacKeyConfig,
  resolveWebCrypto,
  type ImportedHmacKey,
  type SerializedHmacKeyConfig,
  type WebCryptoPort
} from "./config.js";
import { encodeBase64Url, encodeUtf8 } from "./encoding.js";
import {
  CloudflareAdapterError,
  sanitizeConfigFailure,
  sanitizeCryptoFailure
} from "./errors.js";

const UPLOAD_TOKEN_PATTERN =
  /^tm_u1_[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{43}$/;
const DELETION_TOKEN_PATTERN =
  /^tm_d1_[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{43}$/;

export interface CloudflareRateLimitKeyConfig {
  readonly enrollmentEdgeKey: SerializedHmacKeyConfig;
  readonly ingestTokenKey: SerializedHmacKeyConfig;
  readonly deletionTokenKey: SerializedHmacKeyConfig;
}

export interface NonReversibleRateLimitKeyDeriver {
  deriveEnrollmentEdgeKey(edgeInput: unknown): Promise<string>;
  deriveIngestTokenKey(bearerToken: unknown): Promise<string>;
  deriveDeletionTokenKey(bearerToken: unknown): Promise<string>;
}

function parseRateLimitConfig(input: unknown): CloudflareRateLimitKeyConfig {
  const record = asStrictRecord(input, [
    "enrollmentEdgeKey",
    "ingestTokenKey",
    "deletionTokenKey"
  ]);
  const enrollmentEdgeKey = parseHmacKeyConfig(record["enrollmentEdgeKey"]);
  const ingestTokenKey = parseHmacKeyConfig(record["ingestTokenKey"]);
  const deletionTokenKey = parseHmacKeyConfig(record["deletionTokenKey"]);
  assertDistinctKeyConfigs([
    enrollmentEdgeKey,
    ingestTokenKey,
    deletionTokenKey
  ]);
  return Object.freeze({
    enrollmentEdgeKey,
    ingestTokenKey,
    deletionTokenKey
  });
}

async function deriveRateKey(
  crypto: WebCryptoPort,
  key: CryptoKey,
  prefix: "rl_e1_" | "rl_i1_" | "rl_d1_",
  purpose: string,
  input: string
): Promise<string> {
  const domain = encodeUtf8(`tokenmonster:rate:${purpose}:v1\u0000`);
  const rawInput = encodeUtf8(input);
  const message = new Uint8Array(domain.length + rawInput.length);
  message.set(domain);
  message.set(rawInput, domain.length);
  domain.fill(0);
  rawInput.fill(0);
  try {
    const digest = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, message)
    );
    try {
      if (digest.length !== 32) {
        throw new CloudflareAdapterError("CRYPTO_OPERATION_FAILED");
      }
      return `${prefix}${encodeBase64Url(digest)}`;
    } finally {
      digest.fill(0);
    }
  } catch (error: unknown) {
    sanitizeCryptoFailure(error);
  } finally {
    message.fill(0);
  }
}

function assertEdgeInput(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length < 1 ||
    input.length > 256 ||
    input !== input.trim() ||
    /[\u0000-\u001f\u007f]/.test(input)
  ) {
    throw new CloudflareAdapterError("INPUT_INVALID");
  }
  return input;
}

function assertBearer(input: unknown, pattern: RegExp): string {
  if (typeof input !== "string" || !pattern.test(input)) {
    throw new CloudflareAdapterError("INPUT_INVALID");
  }
  return input;
}

class WorkerRateLimitKeyDeriver
  implements NonReversibleRateLimitKeyDeriver
{
  readonly #crypto: WebCryptoPort;
  readonly #enrollmentEdgeKey: CryptoKey;
  readonly #ingestTokenKey: CryptoKey;
  readonly #deletionTokenKey: CryptoKey;

  constructor(input: {
    readonly crypto: WebCryptoPort;
    readonly enrollmentEdgeKey: ImportedHmacKey;
    readonly ingestTokenKey: ImportedHmacKey;
    readonly deletionTokenKey: ImportedHmacKey;
  }) {
    this.#crypto = input.crypto;
    this.#enrollmentEdgeKey = input.enrollmentEdgeKey.key;
    this.#ingestTokenKey = input.ingestTokenKey.key;
    this.#deletionTokenKey = input.deletionTokenKey.key;
  }

  async deriveEnrollmentEdgeKey(edgeInput: unknown): Promise<string> {
    return await deriveRateKey(
      this.#crypto,
      this.#enrollmentEdgeKey,
      "rl_e1_",
      "enrollment-edge",
      assertEdgeInput(edgeInput)
    );
  }

  async deriveIngestTokenKey(bearerToken: unknown): Promise<string> {
    return await deriveRateKey(
      this.#crypto,
      this.#ingestTokenKey,
      "rl_i1_",
      "ingest-token",
      assertBearer(bearerToken, UPLOAD_TOKEN_PATTERN)
    );
  }

  async deriveDeletionTokenKey(bearerToken: unknown): Promise<string> {
    return await deriveRateKey(
      this.#crypto,
      this.#deletionTokenKey,
      "rl_d1_",
      "deletion-token",
      assertBearer(bearerToken, DELETION_TOKEN_PATTERN)
    );
  }

  toJSON(): Readonly<{ name: "NonReversibleRateLimitKeyDeriver" }> {
    return Object.freeze({ name: "NonReversibleRateLimitKeyDeriver" });
  }
}

export async function createNonReversibleRateLimitKeyDeriver(
  input: unknown,
  cryptoInput?: WebCryptoPort
): Promise<NonReversibleRateLimitKeyDeriver> {
  let config: CloudflareRateLimitKeyConfig;
  let crypto: WebCryptoPort;
  try {
    config = parseRateLimitConfig(input);
    crypto = resolveWebCrypto(cryptoInput);
  } catch (error: unknown) {
    sanitizeConfigFailure(error);
  }
  try {
    const enrollmentEdgeKey = await importHmacKey(
      config.enrollmentEdgeKey,
      crypto
    );
    const ingestTokenKey = await importHmacKey(config.ingestTokenKey, crypto);
    const deletionTokenKey = await importHmacKey(
      config.deletionTokenKey,
      crypto
    );
    return Object.freeze(
      new WorkerRateLimitKeyDeriver({
        crypto,
        enrollmentEdgeKey,
        ingestTokenKey,
        deletionTokenKey
      })
    );
  } catch (error: unknown) {
    sanitizeConfigFailure(error);
  }
}
