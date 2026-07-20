import type {
  CredentialScope,
  CredentialService,
  HmacSha256Digest,
  IssuedCredential,
  PresentedCredential,
  StoredCredential
} from "@tokenmonster/api-domain";

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
import {
  decodeCanonicalBase64Url,
  encodeBase64Url,
  encodeUtf8
} from "./encoding.js";
import {
  CloudflareAdapterError,
  sanitizeConfigFailure,
  sanitizeCryptoFailure
} from "./errors.js";

const SECRET_BYTES = 32;
const PUBLIC_ID_BYTES = 18;
const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{16,32}$/;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;
const INSTALLATION_ID_PATTERN = /^ins_[A-Za-z0-9_-]{22}$/;
const DELETION_JOB_ID_PATTERN = /^del_[A-Za-z0-9_-]{22}$/;
const TOKEN_PATTERN_BY_SCOPE: Readonly<Record<CredentialScope, RegExp>> =
  Object.freeze({
    upload: /^tm_u1_([A-Za-z0-9_-]{16,32})\.([A-Za-z0-9_-]{43})$/,
    deletion: /^tm_d1_([A-Za-z0-9_-]{16,32})\.([A-Za-z0-9_-]{43})$/,
    "deletion-status":
      /^tm_s1_([A-Za-z0-9_-]{16,32})\.([A-Za-z0-9_-]{43})$/,
    "enrollment-recovery":
      /^tm_r2_([A-Za-z0-9_-]{24})\.([A-Za-z0-9_-]{43})$/
  });
const PREFIX_BY_SCOPE: Readonly<Record<CredentialScope, string>> =
  Object.freeze({
    upload: "tm_u1_",
    deletion: "tm_d1_",
    "deletion-status": "tm_s1_",
    "enrollment-recovery": "tm_r2_"
  });

export interface CloudflareCredentialServiceConfig {
  readonly currentPepper: SerializedHmacKeyConfig;
  readonly previousPepper?: SerializedHmacKeyConfig;
  /** Stable for the maximum deletion-job replay window. */
  readonly deletionStatusDerivationKey: SerializedHmacKeyConfig;
  /** Independent from credential verification and rate-limit keys. */
  readonly suppressionKey: SerializedHmacKeyConfig;
}

type ParsedToken = Readonly<{
  publicTokenId: string;
  secret: Uint8Array<ArrayBuffer>;
  version: 1 | 2;
}>;

function parseCredentialConfig(input: unknown): CloudflareCredentialServiceConfig {
  const record = asStrictRecord(
    input,
    ["currentPepper", "deletionStatusDerivationKey", "suppressionKey"],
    ["previousPepper"]
  );
  const currentPepper = parseHmacKeyConfig(record["currentPepper"]);
  const previousPepper = Object.hasOwn(record, "previousPepper")
    ? parseHmacKeyConfig(record["previousPepper"])
    : undefined;
  const deletionStatusDerivationKey = parseHmacKeyConfig(
    record["deletionStatusDerivationKey"]
  );
  const suppressionKey = parseHmacKeyConfig(record["suppressionKey"]);
  const allKeys = [
    currentPepper,
    ...(previousPepper === undefined ? [] : [previousPepper]),
    deletionStatusDerivationKey,
    suppressionKey
  ];
  assertDistinctKeyConfigs(allKeys);
  return Object.freeze({
    currentPepper,
    ...(previousPepper === undefined ? {} : { previousPepper }),
    deletionStatusDerivationKey,
    suppressionKey
  });
}

function randomBytes(
  crypto: WebCryptoPort,
  length: number
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  try {
    crypto.getRandomValues(bytes);
    return bytes;
  } catch (error: unknown) {
    bytes.fill(0);
    sanitizeCryptoFailure(error);
  }
}

async function hmacSign(
  crypto: WebCryptoPort,
  key: CryptoKey,
  data: Uint8Array<ArrayBuffer>
): Promise<Uint8Array<ArrayBuffer>> {
  try {
    const digest = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, data)
    );
    if (digest.length !== 32) {
      digest.fill(0);
      throw new CloudflareAdapterError("CRYPTO_OPERATION_FAILED");
    }
    return digest;
  } catch (error: unknown) {
    sanitizeCryptoFailure(error);
  }
}

async function hmacSignText(
  crypto: WebCryptoPort,
  key: CryptoKey,
  input: string
): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = encodeUtf8(input);
  try {
    return await hmacSign(crypto, key, bytes);
  } finally {
    bytes.fill(0);
  }
}

function tokenFromParts(
  scope: CredentialScope,
  publicTokenId: string,
  secret: Uint8Array<ArrayBuffer>
): string {
  return `${PREFIX_BY_SCOPE[scope]}${publicTokenId}.${encodeBase64Url(secret)}`;
}

function credentialVerifierInput(
  scope: CredentialScope,
  version: 1 | 2,
  secret: Uint8Array<ArrayBuffer>
): Uint8Array<ArrayBuffer> {
  const domain = encodeUtf8(
    `tokenmonster:credential:${scope}:v${version}\u0000`
  );
  try {
    const input = new Uint8Array(domain.length + secret.length);
    input.set(domain);
    input.set(secret, domain.length);
    return input;
  } finally {
    domain.fill(0);
  }
}

function transientIssuedCredential(
  bearerToken: string,
  stored: StoredCredential
): IssuedCredential {
  const issued = {
    entropyBits: 256 as const,
    stored
  } as IssuedCredential & {
    toJSON(): Readonly<{
      name: "IssuedCredential";
      entropyBits: 256;
      stored: StoredCredential;
    }>;
  };
  Object.defineProperty(issued, "bearerToken", {
    configurable: false,
    enumerable: false,
    value: bearerToken,
    writable: false
  });
  Object.defineProperty(issued, "toJSON", {
    configurable: false,
    enumerable: false,
    value: () =>
      Object.freeze({
        name: "IssuedCredential" as const,
        entropyBits: 256 as const,
        stored
      }),
    writable: false
  });
  return Object.freeze(issued);
}

function parseTokenForScope(
  bearerToken: unknown,
  scope: CredentialScope
): ParsedToken | null {
  if (typeof bearerToken !== "string" || bearerToken.length > 96) return null;
  const patterns: readonly Readonly<{ version: 1 | 2; pattern: RegExp }>[] =
    scope === "upload"
      ? [
          { version: 1, pattern: TOKEN_PATTERN_BY_SCOPE.upload },
          {
            version: 2,
            pattern:
              /^tm_u2_([A-Za-z0-9_-]{24})\.([A-Za-z0-9_-]{43})$/
          }
        ]
      : scope === "deletion"
        ? [
            { version: 1, pattern: TOKEN_PATTERN_BY_SCOPE.deletion },
            {
              version: 2,
              pattern:
                /^tm_d2_([A-Za-z0-9_-]{24})\.([A-Za-z0-9_-]{43})$/
            }
          ]
        : scope === "deletion-status"
          ? [
              {
                version: 1,
                pattern: TOKEN_PATTERN_BY_SCOPE["deletion-status"]
              }
            ]
          : [
              {
                version: 2,
                pattern:
                  /^tm_r2_([A-Za-z0-9_-]{24})\.([A-Za-z0-9_-]{43})$/
              }
            ];
  for (const candidate of patterns) {
    const match = candidate.pattern.exec(bearerToken);
    const publicTokenId = match?.[1];
    const encodedSecret = match?.[2];
    if (publicTokenId === undefined || encodedSecret === undefined) continue;
    const secret = decodeCanonicalBase64Url(encodedSecret, SECRET_BYTES);
    if (secret !== null) {
      return Object.freeze({
        publicTokenId,
        secret,
        version: candidate.version
      });
    }
  }
  return null;
}

function parseExpectedCredential(input: unknown): StoredCredential | null {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return null;
    }
    const keys = Reflect.ownKeys(input);
    if (
      keys.length !== 4 ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          !["scope", "publicTokenId", "hmacDigest", "hmacKeyId"].includes(key)
      )
    ) {
      return null;
    }
    const record = input as Record<string, unknown>;
    const scope = record["scope"];
    const publicTokenId = record["publicTokenId"];
    const hmacDigest = record["hmacDigest"];
    const hmacKeyId = record["hmacKeyId"];
    if (
      (scope !== "upload" &&
        scope !== "deletion" &&
        scope !== "deletion-status" &&
        scope !== "enrollment-recovery") ||
      typeof publicTokenId !== "string" ||
      !PUBLIC_ID_PATTERN.test(publicTokenId) ||
      typeof hmacDigest !== "string" ||
      !DIGEST_PATTERN.test(hmacDigest) ||
      typeof hmacKeyId !== "string" ||
      !KEY_ID_PATTERN.test(hmacKeyId)
    ) {
      return null;
    }
    return Object.freeze({ scope, publicTokenId, hmacDigest, hmacKeyId });
  } catch {
    return null;
  }
}

class WorkerCredentialService implements CredentialService {
  readonly #crypto: WebCryptoPort;
  readonly #currentPepper: ImportedHmacKey;
  readonly #pepperById: ReadonlyMap<string, CryptoKey>;
  readonly #deletionStatusKey: ImportedHmacKey;
  readonly #suppressionKey: CryptoKey;

  constructor(input: {
    readonly crypto: WebCryptoPort;
    readonly currentPepper: ImportedHmacKey;
    readonly previousPepper?: ImportedHmacKey;
    readonly deletionStatusKey: ImportedHmacKey;
    readonly suppressionKey: ImportedHmacKey;
  }) {
    this.#crypto = input.crypto;
    this.#currentPepper = input.currentPepper;
    this.#pepperById = new Map([
      [input.currentPepper.keyId, input.currentPepper.key],
      ...(input.previousPepper === undefined
        ? []
        : ([[input.previousPepper.keyId, input.previousPepper.key]] as const))
    ]);
    this.#deletionStatusKey = input.deletionStatusKey;
    this.#suppressionKey = input.suppressionKey.key;
  }

  async issue(scope: "upload" | "deletion"): Promise<IssuedCredential> {
    if (scope !== "upload" && scope !== "deletion") {
      throw new CloudflareAdapterError("INPUT_INVALID");
    }
    const publicBytes = randomBytes(this.#crypto, PUBLIC_ID_BYTES);
    const secret = randomBytes(this.#crypto, SECRET_BYTES);
    try {
      return await this.#issueFromBytes(scope, publicBytes, secret);
    } finally {
      publicBytes.fill(0);
      secret.fill(0);
    }
  }

  async acceptPresentedV2(
    scope: "upload" | "deletion" | "enrollment-recovery",
    bearerToken: string
  ): Promise<StoredCredential> {
    if (
      scope !== "upload" &&
      scope !== "deletion" &&
      scope !== "enrollment-recovery"
    ) {
      throw new CloudflareAdapterError("INPUT_INVALID");
    }
    const parsed = parseTokenForScope(bearerToken, scope);
    if (parsed === null || parsed.version !== 2) {
      throw new CloudflareAdapterError("INPUT_INVALID");
    }
    try {
      return await this.#storedFromSecret(
        scope,
        2,
        parsed.publicTokenId,
        parsed.secret,
        this.#currentPepper
      );
    } finally {
      parsed.secret.fill(0);
    }
  }

  async issueDeletionStatus(jobId: string): Promise<IssuedCredential> {
    if (
      typeof jobId !== "string" ||
      !DELETION_JOB_ID_PATTERN.test(jobId)
    ) {
      throw new CloudflareAdapterError("INPUT_INVALID");
    }
    const publicDigest = await hmacSignText(
      this.#crypto,
      this.#deletionStatusKey.key,
      `tokenmonster:deletion-status:public:v1\u0000${jobId}`
    );
    try {
      const secret = await hmacSignText(
        this.#crypto,
        this.#deletionStatusKey.key,
        `tokenmonster:deletion-status:secret:v1\u0000${jobId}`
      );
      const publicBytes = publicDigest.slice(0, PUBLIC_ID_BYTES);
      try {
        return await this.#issueFromBytes(
          "deletion-status",
          publicBytes,
          secret,
          this.#deletionStatusKey
        );
      } finally {
        publicBytes.fill(0);
        secret.fill(0);
      }
    } finally {
      publicDigest.fill(0);
    }
  }

  async inspect(bearerToken: string): Promise<PresentedCredential | null> {
    if (typeof bearerToken !== "string" || bearerToken.length > 96) return null;
    for (const scope of [
      "upload",
      "deletion",
      "deletion-status",
      "enrollment-recovery"
    ] as const) {
      const parsed = parseTokenForScope(bearerToken, scope);
      if (parsed !== null) {
        try {
          return Object.freeze({ publicTokenId: parsed.publicTokenId });
        } finally {
          parsed.secret.fill(0);
        }
      }
    }
    return null;
  }

  async verify(
    bearerToken: string,
    expectedInput: StoredCredential
  ): Promise<boolean> {
    const expected = parseExpectedCredential(expectedInput);
    if (expected === null) return false;
    const parsed = parseTokenForScope(bearerToken, expected.scope);
    if (parsed === null) return false;
    try {
      if (parsed.publicTokenId !== expected.publicTokenId) return false;
      const pepper =
        expected.scope === "deletion-status"
          ? expected.hmacKeyId === this.#deletionStatusKey.keyId
            ? this.#deletionStatusKey.key
            : undefined
          : this.#pepperById.get(expected.hmacKeyId);
      const digest = decodeCanonicalBase64Url(expected.hmacDigest, 32);
      if (pepper === undefined || digest === null) {
        digest?.fill(0);
        return false;
      }
      try {
        const verifierInput = credentialVerifierInput(
          expected.scope,
          parsed.version,
          parsed.secret
        );
        try {
          const verified = await this.#crypto.subtle.verify(
            "HMAC",
            pepper,
            digest,
            verifierInput
          );
          return verified === true;
        } finally {
          verifierInput.fill(0);
        }
      } catch (error: unknown) {
        sanitizeCryptoFailure(error);
      } finally {
        digest.fill(0);
      }
    } finally {
      parsed.secret.fill(0);
    }
  }

  async deriveSuppressionMarker(
    installationId: string
  ): Promise<HmacSha256Digest> {
    if (
      typeof installationId !== "string" ||
      !INSTALLATION_ID_PATTERN.test(installationId)
    ) {
      throw new CloudflareAdapterError("INPUT_INVALID");
    }
    const digest = await hmacSignText(
      this.#crypto,
      this.#suppressionKey,
      `tokenmonster:suppression:v1\u0000${installationId}`
    );
    try {
      return encodeBase64Url(digest);
    } finally {
      digest.fill(0);
    }
  }

  toJSON(): Readonly<{ name: "CloudflareCredentialService" }> {
    return Object.freeze({ name: "CloudflareCredentialService" });
  }

  async #issueFromBytes(
    scope: CredentialScope,
    publicBytes: Uint8Array<ArrayBuffer>,
    secret: Uint8Array<ArrayBuffer>,
    verifier: ImportedHmacKey = this.#currentPepper
  ): Promise<IssuedCredential> {
    const publicTokenId = encodeBase64Url(publicBytes);
    const bearerToken = tokenFromParts(scope, publicTokenId, secret);
    const stored = await this.#storedFromSecret(
      scope,
      1,
      publicTokenId,
      secret,
      verifier
    );
    return transientIssuedCredential(bearerToken, stored);
  }

  async #storedFromSecret(
    scope: CredentialScope,
    version: 1 | 2,
    publicTokenId: string,
    secret: Uint8Array<ArrayBuffer>,
    verifier: ImportedHmacKey
  ): Promise<StoredCredential> {
    const verifierInput = credentialVerifierInput(scope, version, secret);
    let digest: Uint8Array<ArrayBuffer>;
    try {
      digest = await hmacSign(this.#crypto, verifier.key, verifierInput);
    } finally {
      verifierInput.fill(0);
    }
    try {
      const stored: StoredCredential = Object.freeze({
        scope,
        publicTokenId,
        hmacDigest: encodeBase64Url(digest),
        hmacKeyId: verifier.keyId
      });
      return stored;
    } finally {
      digest.fill(0);
    }
  }
}

export async function createCloudflareCredentialService(
  input: unknown,
  cryptoInput?: WebCryptoPort
): Promise<CredentialService> {
  let config: CloudflareCredentialServiceConfig;
  let crypto: WebCryptoPort;
  try {
    config = parseCredentialConfig(input);
    crypto = resolveWebCrypto(cryptoInput);
  } catch (error: unknown) {
    sanitizeConfigFailure(error);
  }

  try {
    const currentPepper = await importHmacKey(config.currentPepper, crypto);
    const previousPepper =
      config.previousPepper === undefined
        ? undefined
        : await importHmacKey(config.previousPepper, crypto);
    const deletionStatusKey = await importHmacKey(
      config.deletionStatusDerivationKey,
      crypto
    );
    const suppressionKey = await importHmacKey(config.suppressionKey, crypto);
    return Object.freeze(
      new WorkerCredentialService({
        crypto,
        currentPepper,
        ...(previousPepper === undefined ? {} : { previousPepper }),
        deletionStatusKey,
        suppressionKey
      })
    );
  } catch (error: unknown) {
    sanitizeConfigFailure(error);
  }
}
