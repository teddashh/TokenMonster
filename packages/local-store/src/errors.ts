export type LocalStoreErrorCode =
  | "BATCH_TOO_LARGE"
  | "CLOUD_MIRROR_REVISION_CONFLICT"
  | "CLOUD_MIRROR_STALE"
  | "CORRUPT_STORAGE"
  | "DUPLICATE_DAILY_KEY"
  | "INVALID_AUTHORITY"
  | "INVALID_CONFIG"
  | "INVALID_CLOUD_MIRROR"
  | "INVALID_CLOUD_MIRROR_RECEIPT"
  | "INVALID_DAILY_AGGREGATE"
  | "INVALID_SCAN_LEDGER"
  | "INVALID_MONSTER_SNAPSHOT"
  | "INVALID_OPEN_OPTIONS"
  | "INVALID_OUTBOX_ENTRY"
  | "INVALID_QUERY"
  | "MIGRATION_FAILED"
  | "MONSTER_REVISION_CONFLICT"
  | "OUTBOX_BATCH_CONFLICT"
  | "REVISION_EXHAUSTED"
  | "STORE_CLOSED"
  | "UNSUPPORTED_SCHEMA";

/**
 * Errors deliberately contain a stable code and content-free message only.
 * Callers may log the code, but must not log rejected input or bound values.
 */
export class LocalStoreError extends Error {
  readonly code: LocalStoreErrorCode;

  constructor(code: LocalStoreErrorCode, message: string) {
    super(message);
    this.name = "LocalStoreError";
    this.code = code;
  }
}
