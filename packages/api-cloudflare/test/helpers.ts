import type {
  CloudflareCredentialServiceConfig,
  CloudflareRateLimitKeyConfig,
  SerializedHmacKeyConfig,
  WebCryptoPort
} from "../src/index.js";

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function encode(bytes: Uint8Array): string {
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    result += ALPHABET[first >>> 2] ?? "";
    result +=
      ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >>> 4)] ?? "";
    if (second !== undefined) {
      result +=
        ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >>> 6)] ?? "";
    }
    if (third !== undefined) result += ALPHABET[third & 0x3f] ?? "";
  }
  return result;
}

export function secret(seed: number): string {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (seed * 53 + index * 29) & 0xff;
  }
  return encode(bytes);
}

export function key(keyId: string, seed: number): SerializedHmacKeyConfig {
  return Object.freeze({ keyId, secret: secret(seed) });
}

export function credentialConfig(
  current = key("credential-v2", 2),
  previous?: SerializedHmacKeyConfig
): CloudflareCredentialServiceConfig {
  return Object.freeze({
    currentPepper: current,
    ...(previous === undefined ? {} : { previousPepper: previous }),
    deletionStatusDerivationKey: key("deletion-status-v1", 31),
    suppressionKey: key("suppression-v1", 47)
  });
}

export function rateConfig(): CloudflareRateLimitKeyConfig {
  return Object.freeze({
    enrollmentEdgeKey: key("rate-enrollment-v1", 61),
    ingestTokenKey: key("rate-ingest-v1", 67),
    deletionTokenKey: key("rate-deletion-v1", 71)
  });
}

export function trackedWebCrypto(): Readonly<{
  port: WebCryptoPort;
  verifyCalls: () => number;
}> {
  const runtime = globalThis.crypto;
  let count = 0;
  const subtle = {
    importKey: runtime.subtle.importKey.bind(runtime.subtle),
    sign: runtime.subtle.sign.bind(runtime.subtle),
    verify: async (...input: Parameters<SubtleCrypto["verify"]>) => {
      count += 1;
      return runtime.subtle.verify(...input);
    }
  } as Pick<SubtleCrypto, "importKey" | "sign" | "verify">;
  const port = {
    getRandomValues: runtime.getRandomValues.bind(
      runtime
    ) as Crypto["getRandomValues"],
    subtle
  } as WebCryptoPort;
  return Object.freeze({ port, verifyCalls: () => count });
}

export function signFailingWebCrypto(canary: string): WebCryptoPort {
  const runtime = globalThis.crypto;
  return {
    getRandomValues: runtime.getRandomValues.bind(
      runtime
    ) as Crypto["getRandomValues"],
    subtle: {
      importKey: runtime.subtle.importKey.bind(runtime.subtle),
      sign: async () => {
        throw new Error(canary);
      },
      verify: runtime.subtle.verify.bind(runtime.subtle)
    } as unknown as SubtleCrypto
  };
}
