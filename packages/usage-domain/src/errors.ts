export type UsageDomainErrorCode =
  | "SCHEMA_INVALID"
  | "AUTH_CONTEXT_INVALID"
  | "RECEIVED_AT_INVALID"
  | "BUCKET_OUTSIDE_RETENTION"
  | "CANONICALIZATION_FAILED"
  | "HASH_UNAVAILABLE"
  | "HASH_INVALID"
  | "BATCH_ID_REUSE"
  | "AUTHORITY_CONFLICT"
  | "REVISION_CONFLICT"
  | "PLAN_STALE"
  | "STATE_INVALID"
  | "ANONYMOUS_ROLLUP_CONFLICT";

const HTTP_STATUS_BY_CODE: Readonly<Record<UsageDomainErrorCode, number>> = {
  SCHEMA_INVALID: 400,
  AUTH_CONTEXT_INVALID: 401,
  RECEIVED_AT_INVALID: 500,
  BUCKET_OUTSIDE_RETENTION: 422,
  CANONICALIZATION_FAILED: 500,
  HASH_UNAVAILABLE: 500,
  HASH_INVALID: 500,
  BATCH_ID_REUSE: 409,
  AUTHORITY_CONFLICT: 409,
  REVISION_CONFLICT: 409,
  PLAN_STALE: 409,
  STATE_INVALID: 500,
  ANONYMOUS_ROLLUP_CONFLICT: 409
};

export type UsageDomainErrorDetails = Readonly<
  Record<string, string | number | boolean>
>;

export class UsageDomainError extends Error {
  override readonly name = "UsageDomainError";
  readonly code: UsageDomainErrorCode;
  readonly httpStatus: number;
  readonly details: UsageDomainErrorDetails;

  constructor(
    code: UsageDomainErrorCode,
    message: string,
    details: UsageDomainErrorDetails = {}
  ) {
    super(message);
    this.code = code;
    this.httpStatus = HTTP_STATUS_BY_CODE[code];
    this.details = Object.freeze({ ...details });
  }
}
