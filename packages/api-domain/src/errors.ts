export type ApiDomainErrorCode =
  | "SCHEMA_INVALID"
  | "CONSENT_NOT_GRANTED"
  | "CONSENT_REQUIRED"
  | "ACKNOWLEDGEMENT_IN_FUTURE"
  | "TOKEN_INVALID"
  | "INSTALLATION_PAUSED"
  | "INSTALLATION_DELETING"
  | "INSTALLATION_DELETED"
  | "IDEMPOTENCY_KEY_INVALID"
  | "IDEMPOTENCY_KEY_MISMATCH"
  | "RATE_LIMITED"
  | "COLLECTOR_UNSUPPORTED"
  | "BUCKET_OUTSIDE_RETENTION"
  | "BATCH_ID_REUSE"
  | "AUTHORITY_CONFLICT"
  | "REVISION_CONFLICT"
  | "CREDENTIAL_SERVICE_INVALID"
  | "SERVICE_UNAVAILABLE";

const ERROR_DEFINITIONS: Readonly<
  Record<
    ApiDomainErrorCode,
    Readonly<{ httpStatus: number; title: string; message: string }>
  >
> = Object.freeze({
  SCHEMA_INVALID: {
    httpStatus: 400,
    title: "Invalid request",
    message: "The request failed strict validation."
  },
  CONSENT_NOT_GRANTED: {
    httpStatus: 400,
    title: "Consent not granted",
    message: "Contribution enrollment requires an explicit grant."
  },
  CONSENT_REQUIRED: {
    httpStatus: 403,
    title: "Current consent required",
    message: "The current contribution consent document must be acknowledged."
  },
  ACKNOWLEDGEMENT_IN_FUTURE: {
    httpStatus: 400,
    title: "Invalid acknowledgement time",
    message: "The consent acknowledgement time is outside the allowed clock skew."
  },
  TOKEN_INVALID: {
    httpStatus: 401,
    title: "Invalid credential",
    message: "The bearer credential is invalid for this operation."
  },
  INSTALLATION_PAUSED: {
    httpStatus: 403,
    title: "Contribution paused",
    message: "This contribution is paused and cannot upload snapshots."
  },
  INSTALLATION_DELETING: {
    httpStatus: 409,
    title: "Deletion in progress",
    message: "This contribution is already being deleted."
  },
  INSTALLATION_DELETED: {
    httpStatus: 410,
    title: "Contribution deleted",
    message: "This contribution has been deleted."
  },
  IDEMPOTENCY_KEY_INVALID: {
    httpStatus: 400,
    title: "Invalid idempotency key",
    message: "A valid idempotency key is required."
  },
  IDEMPOTENCY_KEY_MISMATCH: {
    httpStatus: 400,
    title: "Idempotency key mismatch",
    message: "The request idempotency key does not match the batch identifier."
  },
  RATE_LIMITED: {
    httpStatus: 429,
    title: "Rate limited",
    message: "The request rate limit was exceeded."
  },
  COLLECTOR_UNSUPPORTED: {
    httpStatus: 409,
    title: "Unsupported collector",
    message: "The collector identity is not supported by this API release."
  },
  BUCKET_OUTSIDE_RETENTION: {
    httpStatus: 422,
    title: "Bucket outside retention",
    message: "An ingest bucket is outside the current identifiable UTC window."
  },
  BATCH_ID_REUSE: {
    httpStatus: 409,
    title: "Batch identifier reused",
    message: "The batch identifier was reused for a different snapshot."
  },
  AUTHORITY_CONFLICT: {
    httpStatus: 409,
    title: "Collector authority conflict",
    message: "A UTC source window is already bound to another collector authority."
  },
  REVISION_CONFLICT: {
    httpStatus: 409,
    title: "Revision conflict",
    message: "An equal revision contains different absolute aggregate values."
  },
  CREDENTIAL_SERVICE_INVALID: {
    httpStatus: 500,
    title: "Credential service error",
    message: "The credential service returned an invalid credential artifact."
  },
  SERVICE_UNAVAILABLE: {
    httpStatus: 503,
    title: "Service unavailable",
    message: "The requested mutation could not be completed safely."
  }
});

export interface ApiProblemDetails {
  readonly type: "about:blank";
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly code: ApiDomainErrorCode;
  readonly requestId: string;
  readonly retryAfterSeconds?: number;
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;

export class ApiDomainError extends Error {
  override readonly name = "ApiDomainError";
  readonly code: ApiDomainErrorCode;
  readonly httpStatus: number;
  readonly title: string;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: ApiDomainErrorCode, retryAfterSeconds?: number) {
    const definition = ERROR_DEFINITIONS[code];
    super(definition.message);
    this.code = code;
    this.httpStatus = definition.httpStatus;
    this.title = definition.title;
    this.retryAfterSeconds =
      retryAfterSeconds === undefined
        ? undefined
        : Math.max(1, Math.min(86_400, Math.trunc(retryAfterSeconds)));
  }

  toProblemDetails(requestId: string): ApiProblemDetails {
    const base = {
      type: "about:blank" as const,
      title: this.title,
      status: this.httpStatus,
      detail: this.message,
      code: this.code,
      requestId: SAFE_REQUEST_ID.test(requestId) ? requestId : "unavailable"
    };
    return this.retryAfterSeconds === undefined
      ? Object.freeze(base)
      : Object.freeze({
          ...base,
          retryAfterSeconds: this.retryAfterSeconds
        });
  }

  toJSON(): Readonly<{
    name: "ApiDomainError";
    code: ApiDomainErrorCode;
    httpStatus: number;
    message: string;
    retryAfterSeconds?: number;
  }> {
    const base = {
      name: "ApiDomainError" as const,
      code: this.code,
      httpStatus: this.httpStatus,
      message: this.message
    };
    return this.retryAfterSeconds === undefined
      ? Object.freeze(base)
      : Object.freeze({
          ...base,
          retryAfterSeconds: this.retryAfterSeconds
        });
  }
}

export function isApiDomainError(error: unknown): error is ApiDomainError {
  return error instanceof ApiDomainError;
}

export async function sanitizeUnexpected<T>(
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (isApiDomainError(error)) throw error;
    throw new ApiDomainError("SERVICE_UNAVAILABLE");
  }
}
