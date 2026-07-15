export type CloudflareAdapterErrorCode =
  | "CONFIG_INVALID"
  | "CRYPTO_UNAVAILABLE"
  | "CRYPTO_OPERATION_FAILED"
  | "INPUT_INVALID";

const ERROR_MESSAGES: Readonly<Record<CloudflareAdapterErrorCode, string>> =
  Object.freeze({
    CONFIG_INVALID: "The Cloudflare adapter configuration is invalid.",
    CRYPTO_UNAVAILABLE: "The Web Crypto runtime is unavailable.",
    CRYPTO_OPERATION_FAILED: "The Web Crypto operation failed.",
    INPUT_INVALID: "The Cloudflare adapter input is invalid."
  });

/**
 * A deliberately small error surface. Messages and JSON never contain input,
 * bearer credentials, key material, or an underlying platform exception.
 */
export class CloudflareAdapterError extends Error {
  override readonly name = "CloudflareAdapterError";
  readonly code: CloudflareAdapterErrorCode;

  constructor(code: CloudflareAdapterErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.code = code;
  }

  toJSON(): Readonly<{
    name: "CloudflareAdapterError";
    code: CloudflareAdapterErrorCode;
    message: string;
  }> {
    return Object.freeze({
      name: this.name,
      code: this.code,
      message: this.message
    });
  }
}

export function isCloudflareAdapterError(
  error: unknown
): error is CloudflareAdapterError {
  return error instanceof CloudflareAdapterError;
}

export function sanitizeConfigFailure(error: unknown): never {
  if (
    isCloudflareAdapterError(error) &&
    error.code === "CRYPTO_UNAVAILABLE"
  ) {
    throw error;
  }
  throw new CloudflareAdapterError("CONFIG_INVALID");
}

export function sanitizeCryptoFailure(error: unknown): never {
  if (isCloudflareAdapterError(error)) {
    throw error;
  }
  throw new CloudflareAdapterError("CRYPTO_OPERATION_FAILED");
}
