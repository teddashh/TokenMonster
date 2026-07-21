import type {
  AuthorityBindingRecord,
  ConsentReceiptRecord,
  CredentialCandidate,
  CredentialLookupPort,
  CredentialScope,
  CurrentUsageRowRecord,
  DeletionRequestRecord,
  DeletionMaintenanceStoragePort,
  DeletionStoragePort,
  DeletionStatusRecord,
  DeletionStatusStoragePort,
  DeletionTransactionPort,
  EnrollmentStoragePort,
  IngestBatchReceiptRecord,
  IngestStoragePort,
  IngestTransactionPort,
  InstallationRecord,
  LifecycleStoragePort,
  LifecycleTransactionPort,
  RecoverableEnrollmentRecord,
  RecoverableEnrollmentStoragePort,
  StoredCredential
} from "@tokenmonster/api-domain";

export type D1MutationBindValue = null | number | string | ArrayBuffer;

export interface D1MutationPreparedStatementLike {
  bind(
    ...values: readonly D1MutationBindValue[]
  ): D1MutationPreparedStatementLike;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<Readonly<{ results: readonly T[] }>>;
  run(): Promise<unknown>;
}

export interface D1MutationSessionLike {
  prepare(query: string): D1MutationPreparedStatementLike;
}

export interface D1MutationResultLike {
  readonly success: boolean;
  /** D1 exposes this for bounded maintenance accounting. */
  readonly meta?: Readonly<{ readonly changes?: number }>;
}

export interface D1MutationDatabaseLike extends D1MutationSessionLike {
  batch(
    statements: D1MutationPreparedStatementLike[]
  ): Promise<readonly D1MutationResultLike[]>;
  withSession(constraint: "first-primary"): D1MutationSessionLike;
}

export interface D1MutationStorageOptions {
  /** UTC current-data window. V1 production policy is 30 days. */
  readonly identifiableRetentionDays?: 30;
  /** Dependency injection exists for deterministic tests only. */
  readonly now?: () => Date;
  /** Must return a fresh opaque value for every attempted batch. */
  readonly createRequestId?: () => string;
}

export interface D1MutationStorage
  extends EnrollmentStoragePort,
    IngestStoragePort,
    DeletionStoragePort,
    DeletionStatusStoragePort,
    DeletionMaintenanceStoragePort,
    CredentialLookupPort,
    LifecycleStoragePort,
    RecoverableEnrollmentStoragePort {}

export type D1MutationAdapterErrorCode =
  | "INPUT_INVALID"
  | "STALE_PREFLIGHT"
  | "SERVICE_UNAVAILABLE";

export class D1MutationAdapterError extends Error {
  override readonly name = "D1MutationAdapterError";

  constructor(readonly code: D1MutationAdapterErrorCode) {
    super(
      code === "INPUT_INVALID"
        ? "The mutation adapter received invalid input."
        : code === "STALE_PREFLIGHT"
          ? "The mutation preflight became stale before commit."
          : "The mutation storage service is unavailable."
    );
  }

  toJSON(): Readonly<{
    name: "D1MutationAdapterError";
    code: D1MutationAdapterErrorCode;
  }> {
    return Object.freeze({ name: this.name, code: this.code });
  }
}

type QueryPort = D1MutationSessionLike;
type UnknownRow = Readonly<Record<string, unknown>>;

type StoredInstallation = Readonly<{
  record: InstallationRecord;
  uploadDigest: ArrayBuffer | null;
  deletionDigest: ArrayBuffer | null;
}>;

type StoredBatch = Readonly<{
  record: IngestBatchReceiptRecord;
  payloadDigest: ArrayBuffer;
}>;

type StoredUsage = Readonly<{
  record: CurrentUsageRowRecord;
  rowDigest: ArrayBuffer;
}>;

type StoredDeletion = Readonly<{
  record: DeletionRequestRecord;
  statusDigest: ArrayBuffer;
  replayDigest: ArrayBuffer;
}>;

// Active consent is retained for the life of the opt-in installation and is
// explicitly purged by deletion. This sentinel is not used for hot usage.
const ACTIVE_CONSENT_EXPIRES_AT = "2099-12-31T23:59:59.999Z";
const BATCH_RECEIPT_RETENTION_DAYS = 7;

const INSTALLATION_SELECT = `SELECT
  installation_id AS installationId,
  status AS status,
  consent_document_revision AS consentDocumentRevision,
  upload_token_id AS uploadTokenId,
  upload_token_hmac AS uploadTokenHmac,
  upload_hmac_key_id AS uploadHmacKeyId,
  deletion_token_id AS deletionTokenId,
  deletion_token_hmac AS deletionTokenHmac,
  deletion_hmac_key_id AS deletionHmacKeyId,
  created_at AS createdAt,
  paused_at AS pausedAt,
  deleting_at AS deletingAt,
  deleted_at AS deletedAt
FROM installations
WHERE installation_id = ?1
LIMIT 1`;

const UPLOAD_CREDENTIAL_SELECT = `SELECT
  installation_id AS installationId,
  upload_token_id AS publicTokenId,
  upload_token_hmac AS hmacDigest,
  upload_hmac_key_id AS hmacKeyId
FROM installations
WHERE upload_token_id = ?1
LIMIT 2`;

const DELETION_CREDENTIAL_SELECT = `SELECT
  installation_id AS installationId,
  deletion_token_id AS publicTokenId,
  deletion_token_hmac AS hmacDigest,
  deletion_hmac_key_id AS hmacKeyId
FROM installations
WHERE deletion_token_id = ?1
UNION ALL
SELECT
  installation_id AS installationId,
  replay_token_id AS publicTokenId,
  replay_token_hmac AS hmacDigest,
  replay_hmac_key_id AS hmacKeyId
FROM deletion_jobs
WHERE replay_token_id = ?1 AND expires_at > ?2
LIMIT 2`;

const STATUS_CREDENTIAL_SELECT = `SELECT
  installation_id AS installationId,
  status_token_id AS publicTokenId,
  status_token_hmac AS hmacDigest,
  status_hmac_key_id AS hmacKeyId
FROM deletion_jobs
WHERE status_token_id = ?1 AND expires_at > ?2
LIMIT 2`;

const RECOVERY_CREDENTIAL_SELECT = `SELECT
  installation_id AS installationId,
  recovery_token_id AS publicTokenId,
  recovery_token_hmac AS hmacDigest,
  recovery_hmac_key_id AS hmacKeyId
FROM recoverable_enrollments
WHERE recovery_token_id = ?1
LIMIT 2`;

const RECOVERABLE_ENROLLMENT_SELECT = `SELECT
  i.installation_id AS installationId,
  i.status AS status,
  i.consent_document_revision AS consentDocumentRevision,
  i.upload_token_id AS uploadTokenId,
  i.upload_token_hmac AS uploadTokenHmac,
  i.upload_hmac_key_id AS uploadHmacKeyId,
  i.deletion_token_id AS deletionTokenId,
  i.deletion_token_hmac AS deletionTokenHmac,
  i.deletion_hmac_key_id AS deletionHmacKeyId,
  i.created_at AS createdAt,
  i.paused_at AS pausedAt,
  i.deleting_at AS deletingAt,
  i.deleted_at AS deletedAt,
  c.event_id AS eventId,
  c.document_revision AS documentRevision,
  c.occurred_at AS acknowledgedAt,
  c.recorded_at AS recordedAt,
  r.recovery_token_id AS recoveryTokenId,
  r.recovery_token_hmac AS recoveryTokenHmac,
  r.recovery_hmac_key_id AS recoveryHmacKeyId
FROM recoverable_enrollments r
JOIN installations i ON i.installation_id = r.installation_id
JOIN consent_receipts c ON c.event_id = r.consent_event_id
WHERE r.recovery_token_id = ?1
LIMIT 2`;

const LATEST_GRANTED_CONSENT_SELECT = `SELECT
  event_id AS eventId,
  installation_id AS installationId,
  document_revision AS documentRevision,
  occurred_at AS acknowledgedAt,
  recorded_at AS recordedAt
FROM consent_receipts
WHERE installation_id = ?1
  AND purpose = 'contribution'
  AND document_revision = ?2
  AND granted = 1
ORDER BY recorded_at DESC, event_id DESC
LIMIT 1`;

const BATCH_SELECT = `SELECT
  installation_id AS installationId,
  batch_id AS batchId,
  payload_hash AS payloadHash,
  applied_bucket_count AS appliedBuckets,
  stale_bucket_count AS staleBuckets,
  idempotent_bucket_count AS idempotentBuckets,
  quarantined_bucket_count AS quarantinedBuckets,
  created_at AS receivedAt
FROM ingest_batches
WHERE installation_id = ?1 AND batch_id = ?2
LIMIT 1`;

const AUTHORITY_SELECT = `SELECT
  installation_id AS installationId,
  bucket_start AS bucketStart,
  collector_kind AS collectorKind,
  adapter_version AS adapterVersion,
  source_version AS sourceVersion,
  created_at AS createdAt
FROM collector_window_bindings
WHERE installation_id = ?1 AND bucket_start = ?2
LIMIT 1`;

const USAGE_SELECT = `SELECT
  installation_id AS installationId,
  bucket_start AS bucketStart,
  provider AS provider,
  model_family AS modelFamily,
  tool AS tool,
  value_quality AS valueQuality,
  revision AS revision,
  input_tokens AS inputTokens,
  output_tokens AS outputTokens,
  cache_read_tokens AS cacheReadTokens,
  cache_write_tokens AS cacheWriteTokens,
  reasoning_tokens AS reasoningTokens,
  other_tokens AS otherTokens,
  total_tokens AS totalTokens,
  collector_kind AS collectorKind,
  adapter_version AS adapterVersion,
  source_version AS sourceVersion,
  row_hash AS rowHash,
  updated_at AS updatedAt
FROM usage_daily_current
WHERE installation_id = ?1
  AND bucket_start = ?2
  AND provider = ?3
  AND model_family = ?4
  AND tool = ?5
LIMIT 1`;

const DELETION_BY_KEY_SELECT = `SELECT
  job_id AS jobId,
  installation_id AS installationId,
  idempotency_key AS idempotencyKey,
  status_token_id AS statusTokenId,
  status_token_hmac AS statusTokenHmac,
  status_hmac_key_id AS statusHmacKeyId,
  replay_token_id AS replayTokenId,
  replay_token_hmac AS replayTokenHmac,
  replay_hmac_key_id AS replayHmacKeyId,
  state AS state,
  anonymous_historical_totals_retained AS retained,
  requested_at AS requestedAt,
  finished_at AS completedAt,
  expires_at AS expiresAt
FROM deletion_jobs
WHERE installation_id = ?1 AND idempotency_key = ?2
LIMIT 1`;

const DELETION_BY_JOB_SELECT = `SELECT
  job_id AS jobId,
  installation_id AS installationId,
  idempotency_key AS idempotencyKey,
  status_token_id AS statusTokenId,
  status_token_hmac AS statusTokenHmac,
  status_hmac_key_id AS statusHmacKeyId,
  replay_token_id AS replayTokenId,
  replay_token_hmac AS replayTokenHmac,
  replay_hmac_key_id AS replayHmacKeyId,
  state AS state,
  anonymous_historical_totals_retained AS retained,
  requested_at AS requestedAt,
  finished_at AS completedAt,
  expires_at AS expiresAt
FROM deletion_jobs
WHERE job_id = ?1
LIMIT 1`;

const DELETION_STATUS_BY_JOB_SELECT = `SELECT
  job_id AS jobId,
  installation_id AS installationId,
  status_token_id AS statusTokenId,
  status_token_hmac AS statusTokenHmac,
  status_hmac_key_id AS statusHmacKeyId,
  state AS state,
  anonymous_historical_totals_retained AS retained,
  requested_at AS requestedAt,
  finished_at AS finishedAt,
  expires_at AS expiresAt
FROM deletion_jobs
WHERE job_id = ?1
LIMIT 1`;

const QUEUED_DELETION_JOB_IDS_SELECT = `SELECT job_id AS jobId
FROM deletion_jobs
WHERE state = 'queued'
ORDER BY expires_at, job_id
LIMIT ?1`;

const MAX_QUEUED_DELETION_JOB_LIMIT = 100;

const GUARD_INSERT = `INSERT INTO mutation_guards (
  request_id, operation, expires_at
) VALUES (?1, ?2, ?3)`;

const GUARD_DELETE = `DELETE FROM mutation_guards WHERE request_id = ?1`;

// The original schema's closed operation enum already classifies `ingest` as
// the upload-authority mutation guard. Pause/resume uses that same guard class
// so existing databases can adopt the additive lifecycle migration without a
// risky rebuild of the foreign-key-connected guard tables. This value is
// diagnostic only; lifecycle still has its own domain and rate-limit route.
const LIFECYCLE_GUARD_OPERATION = "ingest";

const INSTALLATION_GUARD_INSERT = `INSERT INTO mutation_guard_installations (
  request_id,
  installation_id,
  expected_exists,
  expected_status,
  expected_consent_document_revision,
  expected_upload_token_id,
  expected_upload_token_hmac,
  expected_upload_hmac_key_id,
  expected_deletion_token_id,
  expected_deletion_token_hmac,
  expected_deletion_hmac_key_id
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`;

const BATCH_GUARD_INSERT = `INSERT INTO mutation_guard_batches (
  request_id,
  installation_id,
  batch_id,
  expected_exists,
  expected_payload_hash,
  expected_applied_bucket_count,
  expected_stale_bucket_count,
  expected_idempotent_bucket_count,
  expected_quarantined_bucket_count,
  expected_created_at
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`;

const AUTHORITY_GUARD_INSERT = `INSERT INTO mutation_guard_authorities (
  request_id,
  installation_id,
  bucket_start,
  expected_exists,
  expected_collector_kind,
  expected_adapter_version,
  expected_source_version
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`;

const USAGE_GUARD_INSERT = `INSERT INTO mutation_guard_usage (
  request_id,
  installation_id,
  bucket_start,
  provider,
  model_family,
  tool,
  expected_exists,
  expected_revision,
  expected_row_hash
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`;

const DELETION_GUARD_INSERT = `INSERT INTO mutation_guard_deletions (
  request_id,
  installation_id,
  idempotency_key,
  expected_exists,
  expected_job_id,
  expected_state,
  expected_status_token_id,
  expected_status_token_hmac,
  expected_status_hmac_key_id,
  expected_replay_token_id,
  expected_replay_token_hmac,
  expected_replay_hmac_key_id,
  expected_anonymous_historical_totals_retained,
  expected_requested_at,
  expected_finished_at,
  expected_expires_at
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`;

const ENROLLMENT_INSTALL = `INSERT INTO installations (
  installation_id,
  upload_token_id,
  upload_token_hmac,
  upload_hmac_key_id,
  deletion_token_id,
  deletion_token_hmac,
  deletion_hmac_key_id,
  status,
  consent_document_revision,
  created_at,
  credentials_rotated_at,
  paused_at,
  deleting_at,
  deleted_at
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11, ?12, ?13)`;

const CONSENT_INSERT = `INSERT INTO consent_receipts (
  event_id,
  installation_id,
  purpose,
  document_revision,
  granted,
  occurred_at,
  recorded_at,
  expires_at
) VALUES (?1, ?2, 'contribution', ?3, 1, ?4, ?5, ?6)`;

const RECOVERABLE_ENROLLMENT_INSERT = `INSERT INTO recoverable_enrollments (
  recovery_token_id,
  recovery_token_hmac,
  recovery_hmac_key_id,
  installation_id,
  consent_event_id,
  created_at
) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`;

const PAUSE_INSTALLATION_UPDATE = `UPDATE installations SET
  status = 'paused',
  paused_at = ?2
WHERE installation_id = ?1`;

const RESUME_INSTALLATION_UPDATE = `UPDATE installations SET
  status = 'active',
  consent_document_revision = ?2,
  paused_at = NULL
WHERE installation_id = ?1`;

const AUTHORITY_INSERT = `INSERT INTO collector_window_bindings (
  installation_id,
  bucket_start,
  collector_kind,
  adapter_version,
  source_version,
  created_at,
  expires_at
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`;

const USAGE_UPSERT = `INSERT INTO usage_daily_current (
  installation_id,
  bucket_start,
  provider,
  model_family,
  tool,
  value_quality,
  revision,
  input_tokens,
  output_tokens,
  cache_read_tokens,
  cache_write_tokens,
  reasoning_tokens,
  other_tokens,
  total_tokens,
  collector_kind,
  adapter_version,
  source_version,
  row_hash,
  quarantine_status,
  created_at,
  updated_at,
  expires_at
) VALUES (
  ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
  ?12, ?13, ?14, ?15, ?16, ?17, ?18, 'accepted', ?19, ?19, ?20
)
ON CONFLICT (installation_id, bucket_start, provider, model_family, tool)
DO UPDATE SET
  value_quality = excluded.value_quality,
  revision = excluded.revision,
  input_tokens = excluded.input_tokens,
  output_tokens = excluded.output_tokens,
  cache_read_tokens = excluded.cache_read_tokens,
  cache_write_tokens = excluded.cache_write_tokens,
  reasoning_tokens = excluded.reasoning_tokens,
  other_tokens = excluded.other_tokens,
  total_tokens = excluded.total_tokens,
  collector_kind = excluded.collector_kind,
  adapter_version = excluded.adapter_version,
  source_version = excluded.source_version,
  row_hash = excluded.row_hash,
  quarantine_status = 'accepted',
  quarantine_reason_code = NULL,
  quarantined_at = NULL,
  updated_at = excluded.updated_at,
  expires_at = excluded.expires_at`;

const BATCH_INSERT = `INSERT INTO ingest_batches (
  installation_id,
  batch_id,
  payload_hash,
  status,
  bucket_count,
  applied_bucket_count,
  stale_bucket_count,
  idempotent_bucket_count,
  quarantined_bucket_count,
  created_at,
  expires_at
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`;

const DIRTY_UPSERT = `INSERT INTO aggregate_dirty (
  singleton_key, dirty_since, reason, dirty_revision
) VALUES (1, ?1, ?2, 1)
ON CONFLICT (singleton_key) DO UPDATE SET
  dirty_since = min(aggregate_dirty.dirty_since, excluded.dirty_since),
  reason = excluded.reason,
  dirty_revision = aggregate_dirty.dirty_revision + 1`;

const BEGIN_DELETION_INSTALLATION_UPDATE = `UPDATE installations SET
  upload_token_id = NULL,
  upload_token_hmac = NULL,
  upload_hmac_key_id = NULL,
  deletion_token_id = NULL,
  deletion_token_hmac = NULL,
  deletion_hmac_key_id = NULL,
  status = 'deleting',
  deleting_at = ?2,
  receipt_expires_at = ?3
WHERE installation_id = ?1`;

const DELETION_INSERT = `INSERT INTO deletion_jobs (
  job_id,
  installation_id,
  idempotency_key,
  status_token_id,
  status_token_hmac,
  status_hmac_key_id,
  replay_token_id,
  replay_token_hmac,
  replay_hmac_key_id,
  state,
  anonymous_historical_totals_retained,
  requested_at,
  started_at,
  finished_at,
  expires_at,
  failure_code
) VALUES (
  ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
  'queued', 1, ?10, NULL, NULL, ?11, NULL
)`;

const DELETE_USAGE =
  "DELETE FROM usage_daily_current WHERE installation_id = ?1";
const DELETE_AUTHORITIES =
  "DELETE FROM collector_window_bindings WHERE installation_id = ?1";
const DELETE_BATCHES =
  "DELETE FROM ingest_batches WHERE installation_id = ?1";
const DELETE_SHARES =
  "DELETE FROM share_cards WHERE installation_id = ?1";
const DELETE_CONSENT =
  "DELETE FROM consent_receipts WHERE installation_id = ?1";
const DELETE_RESTORED_DELETION_JOBS =
  "DELETE FROM deletion_jobs WHERE installation_id = ?1";
const DELETE_RESTORED_MUTATION_GUARDS = `DELETE FROM mutation_guards
WHERE request_id <> ?2
  AND request_id IN (
    SELECT request_id FROM mutation_guard_installations
      WHERE installation_id = ?1
    UNION
    SELECT request_id FROM mutation_guard_batches
      WHERE installation_id = ?1
    UNION
    SELECT request_id FROM mutation_guard_authorities
      WHERE installation_id = ?1
    UNION
    SELECT request_id FROM mutation_guard_usage
      WHERE installation_id = ?1
    UNION
    SELECT request_id FROM mutation_guard_deletions
      WHERE installation_id = ?1
  )`;

const COMPLETE_INSTALLATION_UPDATE = `UPDATE installations SET
  upload_token_id = NULL,
  upload_token_hmac = NULL,
  upload_hmac_key_id = NULL,
  deletion_token_id = NULL,
  deletion_token_hmac = NULL,
  deletion_hmac_key_id = NULL,
  status = 'deleted',
  deleting_at = coalesce(deleting_at, ?2),
  deleted_at = ?2,
  receipt_expires_at = ?3
WHERE installation_id = ?1`;

const COMPLETE_JOB_UPDATE = `UPDATE deletion_jobs SET
  state = 'complete',
  started_at = coalesce(started_at, requested_at),
  finished_at = ?2,
  failure_code = NULL
WHERE job_id = ?1`;

const INSTALLATION_PAGE_SELECT = `SELECT installation_id AS installationId
FROM installations
WHERE installation_id > ?1
ORDER BY installation_id
LIMIT ?2`;

function fail(code: D1MutationAdapterErrorCode): never {
  throw new D1MutationAdapterError(code);
}

function isRecord(value: unknown): value is UnknownRow {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string {
  if (typeof value !== "string") fail("SERVICE_UNAVAILABLE");
  return value;
}

function asNullableString(value: unknown): string | null {
  if (value === null) return null;
  return asString(value);
}

function asSafeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail("SERVICE_UNAVAILABLE");
  }
  return value as number;
}

function asTokenDecimal(value: unknown): string {
  return String(asSafeInteger(value));
}

function asBlob(value: unknown): ArrayBuffer {
  if (value instanceof ArrayBuffer) {
    return value.slice(0);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength
    ).slice().buffer;
  }
  fail("SERVICE_UNAVAILABLE");
}

function encodeBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function encodeHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function decodeDigest(value: string): ArrayBuffer {
  if (/^[a-f0-9]{64}$/u.test(value)) {
    const bytes = new Uint8Array(32);
    for (let index = 0; index < bytes.length; index += 1) {
      const pair = value.slice(index * 2, index * 2 + 2);
      bytes[index] = Number.parseInt(pair, 16);
    }
    return bytes.buffer;
  }
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) fail("INPUT_INVALID");
  try {
    const binary = atob(
      value.replaceAll("-", "+").replaceAll("_", "/") + "="
    );
    if (binary.length !== 32) fail("INPUT_INVALID");
    const bytes = new Uint8Array(32);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    if (encodeBase64Url(bytes.buffer) !== value) fail("INPUT_INVALID");
    return bytes.buffer;
  } catch (error: unknown) {
    if (error instanceof D1MutationAdapterError) throw error;
    fail("INPUT_INVALID");
  }
}

function decodeCredentialDigest(value: string): ArrayBuffer {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) fail("INPUT_INVALID");
  return decodeDigest(value);
}

function storedCredential(
  scope: CredentialScope,
  publicTokenId: unknown,
  digest: unknown,
  hmacKeyId: unknown
): StoredCredential {
  const bytes = asBlob(digest);
  if (bytes.byteLength !== 32) fail("SERVICE_UNAVAILABLE");
  return Object.freeze({
    scope,
    publicTokenId: asString(publicTokenId),
    hmacDigest: encodeBase64Url(bytes),
    hmacKeyId: asString(hmacKeyId)
  });
}

function credentialsEqual(
  left: StoredCredential | null,
  right: StoredCredential | null
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.scope === right.scope &&
    left.publicTokenId === right.publicTokenId &&
    left.hmacDigest === right.hmacDigest &&
    left.hmacKeyId === right.hmacKeyId
  );
}

async function firstRow(
  port: QueryPort,
  query: string,
  values: readonly D1MutationBindValue[]
): Promise<UnknownRow | null> {
  let row: unknown;
  try {
    row = await port.prepare(query).bind(...values).first<unknown>();
  } catch {
    fail("SERVICE_UNAVAILABLE");
  }
  if (row === null) return null;
  if (!isRecord(row)) fail("SERVICE_UNAVAILABLE");
  return row;
}

async function allRows(
  port: QueryPort,
  query: string,
  values: readonly D1MutationBindValue[]
): Promise<readonly UnknownRow[]> {
  let response: unknown;
  try {
    response = await port.prepare(query).bind(...values).all<unknown>();
  } catch {
    fail("SERVICE_UNAVAILABLE");
  }
  if (!isRecord(response) || !Array.isArray(response["results"])) {
    fail("SERVICE_UNAVAILABLE");
  }
  const results = response["results"];
  if (results.some((row) => !isRecord(row))) fail("SERVICE_UNAVAILABLE");
  return results as readonly UnknownRow[];
}

function addDays(timestamp: string, days: number): string {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) fail("INPUT_INVALID");
  return new Date(parsed + days * 86_400_000).toISOString();
}

function canonicalNow(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail("SERVICE_UNAVAILABLE");
  }
  return value.toISOString();
}

function assertCanonicalInstant(value: string): void {
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds < Date.parse("2020-01-01T00:00:00.000Z") ||
    milliseconds >= Date.parse("2100-01-01T00:00:00.000Z") ||
    new Date(milliseconds).toISOString() !== value
  ) {
    fail("INPUT_INVALID");
  }
}

function createDefaultRequestId(): string {
  try {
    return `guard_${globalThis.crypto.randomUUID()}`;
  } catch {
    fail("SERVICE_UNAVAILABLE");
  }
}

function assertRequestId(value: string): string {
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(value)) fail("SERVICE_UNAVAILABLE");
  return value;
}

function parseInstallation(row: UnknownRow): StoredInstallation {
  const status = asString(row["status"]);
  if (
    status !== "active" &&
    status !== "paused" &&
    status !== "deleting" &&
    status !== "deleted"
  ) {
    fail("SERVICE_UNAVAILABLE");
  }
  const uploadTokenId = asNullableString(row["uploadTokenId"]);
  const uploadHmac = row["uploadTokenHmac"];
  const uploadKeyId = asNullableString(row["uploadHmacKeyId"]);
  const deletionTokenId = asNullableString(row["deletionTokenId"]);
  const deletionHmac = row["deletionTokenHmac"];
  const deletionKeyId = asNullableString(row["deletionHmacKeyId"]);
  const uploadDigest = uploadHmac === null ? null : asBlob(uploadHmac);
  const deletionDigest = deletionHmac === null ? null : asBlob(deletionHmac);
  const pausedAt = asNullableString(row["pausedAt"]);
  if (
    (uploadTokenId === null) !== (uploadDigest === null) ||
    (uploadTokenId === null) !== (uploadKeyId === null) ||
    (deletionTokenId === null) !== (deletionDigest === null) ||
    (deletionTokenId === null) !== (deletionKeyId === null) ||
    (uploadDigest !== null && uploadDigest.byteLength !== 32) ||
    (deletionDigest !== null && deletionDigest.byteLength !== 32) ||
    (status === "paused" && pausedAt === null) ||
    (status === "active" && pausedAt !== null)
  ) {
    fail("SERVICE_UNAVAILABLE");
  }
  const record: InstallationRecord = Object.freeze({
    installationId: asString(row["installationId"]),
    status,
    consentDocumentRevision: asString(row["consentDocumentRevision"]),
    uploadCredential:
      uploadTokenId === null || uploadDigest === null || uploadKeyId === null
        ? null
        : Object.freeze({
            scope: "upload" as const,
            publicTokenId: uploadTokenId,
            hmacDigest: encodeBase64Url(uploadDigest),
            hmacKeyId: uploadKeyId
          }),
    deletionCredential:
      deletionTokenId === null ||
      deletionDigest === null ||
      deletionKeyId === null
        ? null
        : Object.freeze({
            scope: "deletion" as const,
            publicTokenId: deletionTokenId,
            hmacDigest: encodeBase64Url(deletionDigest),
            hmacKeyId: deletionKeyId
          }),
    createdAt: asString(row["createdAt"]),
    pausedAt,
    deletingAt: asNullableString(row["deletingAt"]),
    deletedAt: asNullableString(row["deletedAt"])
  });
  return Object.freeze({ record, uploadDigest, deletionDigest });
}

function parseConsentReceipt(row: UnknownRow): ConsentReceiptRecord {
  return Object.freeze({
    eventId: asString(row["eventId"]),
    installationId: asString(row["installationId"]),
    purpose: "contribution" as const,
    documentRevision: asString(row["documentRevision"]),
    granted: true as const,
    acknowledgedAt: asString(row["acknowledgedAt"]),
    recordedAt: asString(row["recordedAt"])
  });
}

async function readInstallation(
  port: QueryPort,
  installationId: string
): Promise<StoredInstallation | null> {
  const row = await firstRow(port, INSTALLATION_SELECT, [installationId]);
  return row === null ? null : parseInstallation(row);
}

function parseCredentialRow(
  row: UnknownRow,
  scope: CredentialScope
): CredentialCandidate {
  return Object.freeze({
    installationId: asString(row["installationId"]),
    credential: storedCredential(
      scope,
      row["publicTokenId"],
      row["hmacDigest"],
      row["hmacKeyId"]
    )
  });
}

async function readCredentialCandidate(
  port: QueryPort,
  scope: CredentialScope,
  publicTokenId: string,
  at: string
): Promise<CredentialCandidate | null> {
  const query =
    scope === "upload"
      ? UPLOAD_CREDENTIAL_SELECT
      : scope === "deletion"
        ? DELETION_CREDENTIAL_SELECT
        : scope === "deletion-status"
          ? STATUS_CREDENTIAL_SELECT
          : RECOVERY_CREDENTIAL_SELECT;
  const values =
    scope === "deletion" || scope === "deletion-status"
      ? [publicTokenId, at]
      : [publicTokenId];
  const rows = await allRows(port, query, values);
  if (rows.length > 1) fail("SERVICE_UNAVAILABLE");
  const row = rows[0];
  return row === undefined ? null : parseCredentialRow(row, scope);
}

function parseRecoverableEnrollment(row: UnknownRow): RecoverableEnrollmentRecord {
  const installation = parseInstallation(row).record;
  const consentReceipt = parseConsentReceipt(row);
  const recoveryDigest = asBlob(row["recoveryTokenHmac"]);
  if (
    recoveryDigest.byteLength !== 32 ||
    consentReceipt.installationId !== installation.installationId ||
    consentReceipt.documentRevision !== installation.consentDocumentRevision
  ) {
    fail("SERVICE_UNAVAILABLE");
  }
  return Object.freeze({
    installation,
    consentReceipt,
    recoveryCredential: Object.freeze({
      scope: "enrollment-recovery" as const,
      publicTokenId: asString(row["recoveryTokenId"]),
      hmacDigest: encodeBase64Url(recoveryDigest),
      hmacKeyId: asString(row["recoveryHmacKeyId"])
    })
  });
}

function parseBatch(row: UnknownRow): StoredBatch {
  const payloadDigest = asBlob(row["payloadHash"]);
  if (payloadDigest.byteLength !== 32) fail("SERVICE_UNAVAILABLE");
  return Object.freeze({
    payloadDigest,
    record: Object.freeze({
      installationId: asString(row["installationId"]),
      batchId: asString(row["batchId"]),
      payloadHash: encodeHex(payloadDigest),
      receivedAt: asString(row["receivedAt"]),
      summary: Object.freeze({
        appliedBuckets: asSafeInteger(row["appliedBuckets"]),
        staleBuckets: asSafeInteger(row["staleBuckets"]),
        idempotentBuckets: asSafeInteger(row["idempotentBuckets"]),
        quarantinedBuckets: asSafeInteger(row["quarantinedBuckets"])
      })
    })
  });
}

function parseAuthority(row: UnknownRow): AuthorityBindingRecord {
  const collectorKind = asString(row["collectorKind"]);
  if (
    collectorKind !== "tokscale" &&
    collectorKind !== "tokentracker-bridge" &&
    collectorKind !== "tokentracker-sidecar"
  ) {
    fail("SERVICE_UNAVAILABLE");
  }
  return Object.freeze({
    installationId: asString(row["installationId"]),
    bucketStart: asString(row["bucketStart"]),
    collectorKind,
    adapterVersion: asString(row["adapterVersion"]),
    sourceVersion: asString(row["sourceVersion"]),
    createdAt: asString(row["createdAt"])
  });
}

function parseUsage(row: UnknownRow): StoredUsage {
  const provider = asString(row["provider"]);
  if (
    provider !== "anthropic" &&
    provider !== "google" &&
    provider !== "openai" &&
    provider !== "openrouter" &&
    provider !== "xai" &&
    provider !== "other"
  ) {
    fail("SERVICE_UNAVAILABLE");
  }
  const valueQuality = asString(row["valueQuality"]);
  if (valueQuality !== "exact" && valueQuality !== "estimated") {
    fail("SERVICE_UNAVAILABLE");
  }
  const collectorKind = asString(row["collectorKind"]);
  if (
    collectorKind !== "tokscale" &&
    collectorKind !== "tokentracker-bridge" &&
    collectorKind !== "tokentracker-sidecar"
  ) {
    fail("SERVICE_UNAVAILABLE");
  }
  const rowDigest = asBlob(row["rowHash"]);
  if (rowDigest.byteLength !== 32) fail("SERVICE_UNAVAILABLE");
  const installationId = asString(row["installationId"]);
  const bucketStart = asString(row["bucketStart"]);
  const modelFamily = asString(row["modelFamily"]);
  const tool = asString(row["tool"]);
  return Object.freeze({
    rowDigest,
    record: Object.freeze({
      key: [installationId, bucketStart, provider, modelFamily, tool].join(
        "\u001f"
      ),
      installationId,
      bucketStart,
      provider,
      modelFamily,
      tool,
      valueQuality,
      revision: asSafeInteger(row["revision"]),
      tokens: Object.freeze({
        input: asTokenDecimal(row["inputTokens"]),
        output: asTokenDecimal(row["outputTokens"]),
        cacheRead: asTokenDecimal(row["cacheReadTokens"]),
        cacheWrite: asTokenDecimal(row["cacheWriteTokens"]),
        reasoning: asTokenDecimal(row["reasoningTokens"]),
        other: asTokenDecimal(row["otherTokens"]),
        total: asTokenDecimal(row["totalTokens"])
      }),
      collector: Object.freeze({
        kind: collectorKind,
        adapterVersion: asString(row["adapterVersion"]),
        sourceVersion: asString(row["sourceVersion"])
      }),
      rowHash: encodeHex(rowDigest),
      updatedAt: asString(row["updatedAt"])
    })
  });
}

function parseDeletion(row: UnknownRow): StoredDeletion {
  const state = asString(row["state"]);
  if (
    state !== "queued" &&
    state !== "running" &&
    state !== "complete" &&
    state !== "failed"
  ) {
    fail("SERVICE_UNAVAILABLE");
  }
  if (row["retained"] !== 1) fail("SERVICE_UNAVAILABLE");
  const statusDigest = asBlob(row["statusTokenHmac"]);
  const replayDigest = asBlob(row["replayTokenHmac"]);
  if (statusDigest.byteLength !== 32 || replayDigest.byteLength !== 32) {
    fail("SERVICE_UNAVAILABLE");
  }
  return Object.freeze({
    statusDigest,
    replayDigest,
    record: Object.freeze({
      installationId: asString(row["installationId"]),
      idempotencyKey: asString(row["idempotencyKey"]),
      jobId: asString(row["jobId"]),
      state,
      statusCredential: Object.freeze({
        scope: "deletion-status" as const,
        publicTokenId: asString(row["statusTokenId"]),
        hmacDigest: encodeBase64Url(statusDigest),
        hmacKeyId: asString(row["statusHmacKeyId"])
      }),
      replayCredential: Object.freeze({
        scope: "deletion" as const,
        publicTokenId: asString(row["replayTokenId"]),
        hmacDigest: encodeBase64Url(replayDigest),
        hmacKeyId: asString(row["replayHmacKeyId"])
      }),
      requestedAt: asString(row["requestedAt"]),
      completedAt: asNullableString(row["completedAt"]),
      expiresAt: asString(row["expiresAt"]),
      anonymousHistoricalTotalsRetained: true as const
    })
  });
}

function parseDeletionStatus(row: UnknownRow): DeletionStatusRecord {
  const state = asString(row["state"]);
  if (
    state !== "queued" &&
    state !== "running" &&
    state !== "complete" &&
    state !== "failed"
  ) {
    fail("SERVICE_UNAVAILABLE");
  }
  if (row["retained"] !== 1) fail("SERVICE_UNAVAILABLE");
  const statusDigest = asBlob(row["statusTokenHmac"]);
  if (statusDigest.byteLength !== 32) fail("SERVICE_UNAVAILABLE");
  const finishedAt = asNullableString(row["finishedAt"]);
  const terminal = state === "complete" || state === "failed";
  if (terminal !== (finishedAt !== null)) fail("SERVICE_UNAVAILABLE");
  return Object.freeze({
    installationId: asString(row["installationId"]),
    jobId: asString(row["jobId"]),
    state,
    statusCredential: Object.freeze({
      scope: "deletion-status" as const,
      publicTokenId: asString(row["statusTokenId"]),
      hmacDigest: encodeBase64Url(statusDigest),
      hmacKeyId: asString(row["statusHmacKeyId"])
    }),
    requestedAt: asString(row["requestedAt"]),
    finishedAt,
    expiresAt: asString(row["expiresAt"]),
    anonymousHistoricalTotalsRetained: true as const
  });
}

function parseUsageKey(
  installationId: string,
  key: string
): readonly [string, string, string, string] {
  const parts = key.split("\u001f");
  if (
    parts.length !== 5 ||
    parts[0] !== installationId ||
    parts.slice(1).some((part) => part.length === 0)
  ) {
    fail("INPUT_INVALID");
  }
  return [parts[1]!, parts[2]!, parts[3]!, parts[4]!];
}

function guardHeader(
  db: D1MutationDatabaseLike,
  requestId: string,
  operation: string,
  expiresAt: string
): D1MutationPreparedStatementLike {
  return db.prepare(GUARD_INSERT).bind(requestId, operation, expiresAt);
}

function guardCleanup(
  db: D1MutationDatabaseLike,
  requestId: string
): D1MutationPreparedStatementLike {
  return db.prepare(GUARD_DELETE).bind(requestId);
}

function installationGuard(
  db: D1MutationDatabaseLike,
  requestId: string,
  installationId: string,
  expected: StoredInstallation | null
): D1MutationPreparedStatementLike {
  const record = expected?.record;
  return db.prepare(INSTALLATION_GUARD_INSERT).bind(
    requestId,
    installationId,
    expected === null ? 0 : 1,
    record?.status ?? null,
    record?.consentDocumentRevision ?? null,
    record?.uploadCredential?.publicTokenId ?? null,
    expected?.uploadDigest ?? null,
    record?.uploadCredential?.hmacKeyId ?? null,
    record?.deletionCredential?.publicTokenId ?? null,
    expected?.deletionDigest ?? null,
    record?.deletionCredential?.hmacKeyId ?? null
  );
}

function batchGuard(
  db: D1MutationDatabaseLike,
  requestId: string,
  installationId: string,
  batchId: string,
  expected: StoredBatch | null
): D1MutationPreparedStatementLike {
  const summary = expected?.record.summary;
  return db.prepare(BATCH_GUARD_INSERT).bind(
    requestId,
    installationId,
    batchId,
    expected === null ? 0 : 1,
    expected?.payloadDigest ?? null,
    summary?.appliedBuckets ?? null,
    summary?.staleBuckets ?? null,
    summary?.idempotentBuckets ?? null,
    summary?.quarantinedBuckets ?? null,
    expected?.record.receivedAt ?? null
  );
}

function authorityGuard(
  db: D1MutationDatabaseLike,
  requestId: string,
  installationId: string,
  bucketStart: string,
  expected: AuthorityBindingRecord | null
): D1MutationPreparedStatementLike {
  return db.prepare(AUTHORITY_GUARD_INSERT).bind(
    requestId,
    installationId,
    bucketStart,
    expected === null ? 0 : 1,
    expected?.collectorKind ?? null,
    expected?.adapterVersion ?? null,
    expected?.sourceVersion ?? null
  );
}

function usageGuard(
  db: D1MutationDatabaseLike,
  requestId: string,
  installationId: string,
  key: string,
  expected: StoredUsage | null
): D1MutationPreparedStatementLike {
  const [bucketStart, provider, modelFamily, tool] = parseUsageKey(
    installationId,
    key
  );
  return db.prepare(USAGE_GUARD_INSERT).bind(
    requestId,
    installationId,
    bucketStart,
    provider,
    modelFamily,
    tool,
    expected === null ? 0 : 1,
    expected?.record.revision ?? null,
    expected?.rowDigest ?? null
  );
}

function deletionGuard(
  db: D1MutationDatabaseLike,
  requestId: string,
  installationId: string,
  idempotencyKey: string,
  expected: StoredDeletion | null
): D1MutationPreparedStatementLike {
  const record = expected?.record;
  return db.prepare(DELETION_GUARD_INSERT).bind(
    requestId,
    installationId,
    idempotencyKey,
    expected === null ? 0 : 1,
    record?.jobId ?? null,
    record?.state ?? null,
    record?.statusCredential.publicTokenId ?? null,
    expected?.statusDigest ?? null,
    record?.statusCredential.hmacKeyId ?? null,
    record?.replayCredential.publicTokenId ?? null,
    expected?.replayDigest ?? null,
    record?.replayCredential.hmacKeyId ?? null,
    record === undefined ? null : 1,
    record?.requestedAt ?? null,
    record?.completedAt ?? null,
    record?.expiresAt ?? null
  );
}

async function commitBatch(
  db: D1MutationDatabaseLike,
  statements: D1MutationPreparedStatementLike[]
): Promise<void> {
  try {
    const results = await db.batch(statements);
    if (
      results.length !== statements.length ||
      results.some((result) => result.success !== true)
    ) {
      fail("SERVICE_UNAVAILABLE");
    }
  } catch (error: unknown) {
    if (error instanceof D1MutationAdapterError) throw error;
    let text = "";
    try {
      text = String(error);
    } catch {
      fail("SERVICE_UNAVAILABLE");
    }
    if (text.includes("TM_GUARD_")) fail("STALE_PREFLIGHT");
    fail("SERVICE_UNAVAILABLE");
  }
}

class LifecycleRecorder implements LifecycleTransactionPort {
  readonly #consentReceipts = new Map<string, ConsentReceiptRecord | null>();
  #installationLoaded = false;
  #installation: StoredInstallation | null = null;
  #credentialRead = false;
  #credentialCandidate: CredentialCandidate | null = null;
  #pauseAt: string | null = null;
  #resumeInput: Readonly<{
    consentReceipt: ConsentReceiptRecord;
    at: string;
  }> | null = null;

  constructor(
    private readonly db: D1MutationDatabaseLike,
    private readonly session: D1MutationSessionLike,
    private readonly installationId: string,
    private readonly at: string,
    private readonly requestId: string,
    private readonly guardExpiresAt: string
  ) {}

  async findCredentialCandidate(
    scope: "upload",
    publicTokenId: string
  ): Promise<CredentialCandidate | null> {
    if (scope !== "upload" || this.#credentialRead) fail("INPUT_INVALID");
    this.#credentialCandidate = await readCredentialCandidate(
      this.session,
      "upload",
      publicTokenId,
      this.at
    );
    this.#credentialRead = true;
    return this.#credentialCandidate;
  }

  async getInstallation(): Promise<InstallationRecord | null> {
    if (!this.#installationLoaded) {
      this.#installation = await readInstallation(
        this.session,
        this.installationId
      );
      this.#installationLoaded = true;
    }
    return this.#installation?.record ?? null;
  }

  async getLatestGrantedConsentReceipt(
    documentRevision: string
  ): Promise<ConsentReceiptRecord | null> {
    if (!this.#consentReceipts.has(documentRevision)) {
      const row = await firstRow(this.session, LATEST_GRANTED_CONSENT_SELECT, [
        this.installationId,
        documentRevision
      ]);
      this.#consentReceipts.set(
        documentRevision,
        row === null ? null : parseConsentReceipt(row)
      );
    }
    return this.#consentReceipts.get(documentRevision) ?? null;
  }

  async pause(at: string): Promise<void> {
    assertCanonicalInstant(at);
    if (
      this.#pauseAt !== null ||
      this.#resumeInput !== null
    ) {
      fail("INPUT_INVALID");
    }
    this.#pauseAt = at;
  }

  async resume(input: {
    readonly consentReceipt: ConsentReceiptRecord;
    readonly at: string;
  }): Promise<void> {
    const receipt = input.consentReceipt;
    assertCanonicalInstant(input.at);
    if (
      this.#resumeInput !== null ||
      this.#pauseAt !== null ||
      receipt.installationId !== this.installationId ||
      receipt.purpose !== "contribution" ||
      receipt.granted !== true ||
      receipt.recordedAt !== input.at
    ) {
      fail("INPUT_INVALID");
    }
    this.#resumeInput = Object.freeze({
      consentReceipt: Object.freeze({ ...receipt }),
      at: input.at
    });
  }

  async commit(): Promise<void> {
    if (!this.#installationLoaded) {
      this.#installation = await readInstallation(
        this.session,
        this.installationId
      );
      this.#installationLoaded = true;
    }
    const candidate = this.#credentialCandidate;
    if (
      !this.#credentialRead ||
      candidate === null ||
      candidate.installationId !== this.installationId ||
      !credentialsEqual(
        candidate.credential,
        this.#installation?.record.uploadCredential ?? null
      )
    ) {
      fail("STALE_PREFLIGHT");
    }

    const statements: D1MutationPreparedStatementLike[] = [
      guardHeader(
        this.db,
        this.requestId,
        LIFECYCLE_GUARD_OPERATION,
        this.guardExpiresAt
      ),
      installationGuard(
        this.db,
        this.requestId,
        this.installationId,
        this.#installation
      )
    ];
    if (this.#pauseAt !== null) {
      if (this.#installation?.record.status !== "active") {
        fail("STALE_PREFLIGHT");
      }
      statements.push(
        this.db
          .prepare(PAUSE_INSTALLATION_UPDATE)
          .bind(this.installationId, this.#pauseAt)
      );
    }
    if (this.#resumeInput !== null) {
      if (
        this.#installation === null ||
        (this.#installation.record.status !== "active" &&
          this.#installation.record.status !== "paused")
      ) {
        fail("STALE_PREFLIGHT");
      }
      const receipt = this.#resumeInput.consentReceipt;
      statements.push(
        this.db.prepare(RESUME_INSTALLATION_UPDATE).bind(
          this.installationId,
          receipt.documentRevision
        ),
        this.db.prepare(CONSENT_INSERT).bind(
          receipt.eventId,
          receipt.installationId,
          receipt.documentRevision,
          receipt.acknowledgedAt,
          receipt.recordedAt,
          ACTIVE_CONSENT_EXPIRES_AT
        )
      );
    }
    statements.push(guardCleanup(this.db, this.requestId));
    await commitBatch(this.db, statements);
  }
}

class IngestRecorder implements IngestTransactionPort {
  readonly #batches = new Map<string, StoredBatch | null>();
  readonly #authorities = new Map<string, AuthorityBindingRecord | null>();
  readonly #usage = new Map<string, StoredUsage | null>();
  readonly #authorityWrites = new Map<string, AuthorityBindingRecord>();
  readonly #usageWrites = new Map<string, CurrentUsageRowRecord>();
  #receiptWrite: IngestBatchReceiptRecord | null = null;
  #dirtyAt: string | null = null;
  #installationLoaded = false;
  #installation: StoredInstallation | null = null;
  #credentialRead = false;
  #credentialCandidate: CredentialCandidate | null = null;

  constructor(
    private readonly db: D1MutationDatabaseLike,
    private readonly session: D1MutationSessionLike,
    private readonly installationId: string,
    private readonly at: string,
    private readonly retentionDays: number,
    private readonly requestId: string,
    private readonly guardExpiresAt: string
  ) {}

  async findCredentialCandidate(
    scope: "upload",
    publicTokenId: string
  ): Promise<CredentialCandidate | null> {
    if (scope !== "upload" || this.#credentialRead) fail("INPUT_INVALID");
    this.#credentialCandidate = await readCredentialCandidate(
      this.session,
      "upload",
      publicTokenId,
      this.at
    );
    this.#credentialRead = true;
    return this.#credentialCandidate;
  }

  async getInstallation(): Promise<InstallationRecord | null> {
    if (!this.#installationLoaded) {
      this.#installation = await readInstallation(
        this.session,
        this.installationId
      );
      this.#installationLoaded = true;
    }
    return this.#installation?.record ?? null;
  }

  async getBatchReceipt(
    batchId: string
  ): Promise<IngestBatchReceiptRecord | null> {
    if (!this.#batches.has(batchId)) {
      const row = await firstRow(this.session, BATCH_SELECT, [
        this.installationId,
        batchId
      ]);
      this.#batches.set(batchId, row === null ? null : parseBatch(row));
    }
    return this.#batches.get(batchId)?.record ?? null;
  }

  async getAuthorityBinding(
    bucketStart: string
  ): Promise<AuthorityBindingRecord | null> {
    if (!this.#authorities.has(bucketStart)) {
      const row = await firstRow(this.session, AUTHORITY_SELECT, [
        this.installationId,
        bucketStart
      ]);
      this.#authorities.set(
        bucketStart,
        row === null ? null : parseAuthority(row)
      );
    }
    return this.#authorities.get(bucketStart) ?? null;
  }

  async getUsageRow(key: string): Promise<CurrentUsageRowRecord | null> {
    if (!this.#usage.has(key)) {
      const [bucketStart, provider, modelFamily, tool] = parseUsageKey(
        this.installationId,
        key
      );
      const row = await firstRow(this.session, USAGE_SELECT, [
        this.installationId,
        bucketStart,
        provider,
        modelFamily,
        tool
      ]);
      this.#usage.set(key, row === null ? null : parseUsage(row));
    }
    return this.#usage.get(key)?.record ?? null;
  }

  async putAuthorityBinding(binding: AuthorityBindingRecord): Promise<void> {
    if (
      binding.installationId !== this.installationId ||
      !this.#authorities.has(binding.bucketStart) ||
      this.#authorities.get(binding.bucketStart) !== null ||
      this.#authorityWrites.has(binding.bucketStart)
    ) {
      fail("INPUT_INVALID");
    }
    this.#authorityWrites.set(binding.bucketStart, Object.freeze({ ...binding }));
  }

  async putUsageRow(row: CurrentUsageRowRecord): Promise<void> {
    parseUsageKey(this.installationId, row.key);
    if (
      row.installationId !== this.installationId ||
      !this.#usage.has(row.key) ||
      this.#usageWrites.has(row.key)
    ) {
      fail("INPUT_INVALID");
    }
    this.#usageWrites.set(row.key, Object.freeze({ ...row }));
  }

  async putBatchReceipt(receipt: IngestBatchReceiptRecord): Promise<void> {
    if (
      receipt.installationId !== this.installationId ||
      !this.#batches.has(receipt.batchId) ||
      this.#batches.get(receipt.batchId) !== null ||
      this.#receiptWrite !== null
    ) {
      fail("INPUT_INVALID");
    }
    this.#receiptWrite = Object.freeze({ ...receipt });
  }

  async markAggregateDirty(at: string): Promise<void> {
    if (this.#dirtyAt !== null || !Number.isFinite(Date.parse(at))) {
      fail("INPUT_INVALID");
    }
    this.#dirtyAt = at;
  }

  async commit(): Promise<void> {
    if (!this.#installationLoaded) {
      this.#installation = await readInstallation(
        this.session,
        this.installationId
      );
      this.#installationLoaded = true;
    }
    const candidate = this.#credentialCandidate;
    if (
      !this.#credentialRead ||
      candidate === null ||
      candidate.installationId !== this.installationId ||
      !credentialsEqual(
        candidate.credential,
        this.#installation?.record.uploadCredential ?? null
      )
    ) {
      fail("STALE_PREFLIGHT");
    }
    const statements: D1MutationPreparedStatementLike[] = [
      guardHeader(
        this.db,
        this.requestId,
        "ingest",
        this.guardExpiresAt
      ),
      installationGuard(
        this.db,
        this.requestId,
        this.installationId,
        this.#installation
      )
    ];
    for (const [batchId, expected] of this.#batches) {
      statements.push(
        batchGuard(
          this.db,
          this.requestId,
          this.installationId,
          batchId,
          expected
        )
      );
    }
    for (const [bucketStart, expected] of this.#authorities) {
      statements.push(
        authorityGuard(
          this.db,
          this.requestId,
          this.installationId,
          bucketStart,
          expected
        )
      );
    }
    for (const [key, expected] of this.#usage) {
      statements.push(
        usageGuard(
          this.db,
          this.requestId,
          this.installationId,
          key,
          expected
        )
      );
    }
    for (const binding of this.#authorityWrites.values()) {
      statements.push(
        this.db.prepare(AUTHORITY_INSERT).bind(
          binding.installationId,
          binding.bucketStart,
          binding.collectorKind,
          binding.adapterVersion,
          binding.sourceVersion,
          binding.createdAt,
          addDays(binding.bucketStart, this.retentionDays)
        )
      );
    }
    for (const row of this.#usageWrites.values()) {
      statements.push(
        this.db.prepare(USAGE_UPSERT).bind(
          row.installationId,
          row.bucketStart,
          row.provider,
          row.modelFamily,
          row.tool,
          row.valueQuality,
          row.revision,
          row.tokens.input,
          row.tokens.output,
          row.tokens.cacheRead,
          row.tokens.cacheWrite,
          row.tokens.reasoning,
          row.tokens.other,
          row.tokens.total,
          row.collector.kind,
          row.collector.adapterVersion,
          row.collector.sourceVersion,
          decodeDigest(row.rowHash),
          row.updatedAt,
          addDays(row.bucketStart, this.retentionDays)
        )
      );
    }
    const receipt = this.#receiptWrite;
    if (receipt !== null) {
      const bucketCount =
        receipt.summary.appliedBuckets +
        receipt.summary.staleBuckets +
        receipt.summary.idempotentBuckets +
        receipt.summary.quarantinedBuckets;
      const status =
        receipt.summary.quarantinedBuckets === 0
          ? "accepted"
          : receipt.summary.quarantinedBuckets === bucketCount
            ? "quarantined"
            : "partially_quarantined";
      statements.push(
        this.db.prepare(BATCH_INSERT).bind(
          receipt.installationId,
          receipt.batchId,
          decodeDigest(receipt.payloadHash),
          status,
          bucketCount,
          receipt.summary.appliedBuckets,
          receipt.summary.staleBuckets,
          receipt.summary.idempotentBuckets,
          receipt.summary.quarantinedBuckets,
          receipt.receivedAt,
          addDays(receipt.receivedAt, BATCH_RECEIPT_RETENTION_DAYS)
        )
      );
    }
    if (this.#dirtyAt !== null) {
      statements.push(this.db.prepare(DIRTY_UPSERT).bind(this.#dirtyAt, "ingest"));
    }
    statements.push(guardCleanup(this.db, this.requestId));
    await commitBatch(this.db, statements);
  }
}

class DeletionRecorder implements DeletionTransactionPort {
  readonly #deletions = new Map<string, StoredDeletion | null>();
  #installationLoaded = false;
  #installation: StoredInstallation | null = null;
  #credentialRead = false;
  #credentialCandidate: CredentialCandidate | null = null;
  #beginInput: Readonly<{
    request: DeletionRequestRecord;
    at: string;
  }> | null = null;

  constructor(
    private readonly db: D1MutationDatabaseLike,
    private readonly session: D1MutationSessionLike,
    private readonly installationId: string,
    private readonly at: string,
    private readonly requestId: string,
    private readonly guardExpiresAt: string
  ) {}

  async findCredentialCandidate(
    scope: "deletion",
    publicTokenId: string
  ): Promise<CredentialCandidate | null> {
    if (scope !== "deletion" || this.#credentialRead) fail("INPUT_INVALID");
    this.#credentialCandidate = await readCredentialCandidate(
      this.session,
      "deletion",
      publicTokenId,
      this.at
    );
    this.#credentialRead = true;
    return this.#credentialCandidate;
  }

  async getInstallation(): Promise<InstallationRecord | null> {
    if (!this.#installationLoaded) {
      this.#installation = await readInstallation(
        this.session,
        this.installationId
      );
      this.#installationLoaded = true;
    }
    return this.#installation?.record ?? null;
  }

  async getDeletionRequest(
    idempotencyKey: string
  ): Promise<DeletionRequestRecord | null> {
    if (!this.#deletions.has(idempotencyKey)) {
      const row = await firstRow(this.session, DELETION_BY_KEY_SELECT, [
        this.installationId,
        idempotencyKey
      ]);
      this.#deletions.set(
        idempotencyKey,
        row === null ? null : parseDeletion(row)
      );
    }
    return this.#deletions.get(idempotencyKey)?.record ?? null;
  }

  async beginDeletion(input: {
    readonly request: DeletionRequestRecord;
    readonly at: string;
  }): Promise<void> {
    if (
      this.#beginInput !== null ||
      input.request.installationId !== this.installationId ||
      !this.#deletions.has(input.request.idempotencyKey) ||
      this.#deletions.get(input.request.idempotencyKey) !== null ||
      input.request.state !== "queued" ||
      input.request.completedAt !== null
    ) {
      fail("INPUT_INVALID");
    }
    this.#beginInput = Object.freeze({
      request: Object.freeze({ ...input.request }),
      at: input.at
    });
  }

  async commit(): Promise<void> {
    if (!this.#installationLoaded) {
      this.#installation = await readInstallation(
        this.session,
        this.installationId
      );
      this.#installationLoaded = true;
    }
    const candidate = this.#credentialCandidate;
    const installationCredentialMatches =
      candidate !== null &&
      credentialsEqual(
        candidate.credential,
        this.#installation?.record.deletionCredential ?? null
      );
    const replayCredentialMatches =
      candidate !== null &&
      [...this.#deletions.values()].some(
        (deletion) =>
          deletion !== null &&
          credentialsEqual(candidate.credential, deletion.record.replayCredential)
      );
    if (
      !this.#credentialRead ||
      candidate === null ||
      candidate.installationId !== this.installationId ||
      (!installationCredentialMatches && !replayCredentialMatches)
    ) {
      fail("STALE_PREFLIGHT");
    }
    const statements: D1MutationPreparedStatementLike[] = [
      guardHeader(
        this.db,
        this.requestId,
        "begin-delete",
        this.guardExpiresAt
      ),
      installationGuard(
        this.db,
        this.requestId,
        this.installationId,
        this.#installation
      )
    ];
    for (const [idempotencyKey, expected] of this.#deletions) {
      statements.push(
        deletionGuard(
          this.db,
          this.requestId,
          this.installationId,
          idempotencyKey,
          expected
        )
      );
    }
    const begin = this.#beginInput;
    if (begin !== null) {
      const request = begin.request;
      statements.push(
        this.db.prepare(BEGIN_DELETION_INSTALLATION_UPDATE).bind(
          this.installationId,
          begin.at,
          request.expiresAt
        ),
        this.db.prepare(DELETION_INSERT).bind(
          request.jobId,
          request.installationId,
          request.idempotencyKey,
          request.statusCredential.publicTokenId,
          decodeCredentialDigest(request.statusCredential.hmacDigest),
          request.statusCredential.hmacKeyId,
          request.replayCredential.publicTokenId,
          decodeCredentialDigest(request.replayCredential.hmacDigest),
          request.replayCredential.hmacKeyId,
          request.requestedAt,
          request.expiresAt
        )
      );
    }
    statements.push(guardCleanup(this.db, this.requestId));
    await commitBatch(this.db, statements);
  }
}

class CloudD1MutationStorage implements D1MutationStorage {
  readonly #retentionDays: 30;
  readonly #now: () => Date;
  readonly #createRequestId: () => string;

  constructor(
    private readonly db: D1MutationDatabaseLike,
    options: D1MutationStorageOptions
  ) {
    this.#retentionDays = options.identifiableRetentionDays ?? 30;
    this.#now = options.now ?? (() => new Date());
    this.#createRequestId = options.createRequestId ?? createDefaultRequestId;
  }

  async createEnrollmentAtomically(input: {
    readonly installation: InstallationRecord;
    readonly consentReceipt: ConsentReceiptRecord;
  }): Promise<void> {
    const installation = input.installation;
    const receipt = input.consentReceipt;
    if (
      installation.status !== "active" ||
      installation.uploadCredential === null ||
      installation.deletionCredential === null ||
      receipt.installationId !== installation.installationId ||
      receipt.documentRevision !== installation.consentDocumentRevision
    ) {
      fail("INPUT_INVALID");
    }
    const requestId = this.#nextRequestId();
    const expiresAt = this.#guardExpiry();
    await commitBatch(this.db, [
      guardHeader(this.db, requestId, "enrollment", expiresAt),
      installationGuard(
        this.db,
        requestId,
        installation.installationId,
        null
      ),
      this.db.prepare(ENROLLMENT_INSTALL).bind(
        installation.installationId,
        installation.uploadCredential.publicTokenId,
        decodeCredentialDigest(installation.uploadCredential.hmacDigest),
        installation.uploadCredential.hmacKeyId,
        installation.deletionCredential.publicTokenId,
        decodeCredentialDigest(installation.deletionCredential.hmacDigest),
        installation.deletionCredential.hmacKeyId,
        installation.status,
        installation.consentDocumentRevision,
        installation.createdAt,
        installation.pausedAt,
        installation.deletingAt,
        installation.deletedAt
      ),
      this.db.prepare(CONSENT_INSERT).bind(
        receipt.eventId,
        receipt.installationId,
        receipt.documentRevision,
        receipt.acknowledgedAt,
        receipt.recordedAt,
        ACTIVE_CONSENT_EXPIRES_AT
      ),
      guardCleanup(this.db, requestId)
    ]);
  }

  async findRecoverableEnrollment(
    recoveryPublicTokenId: string
  ): Promise<RecoverableEnrollmentRecord | null> {
    if (!/^[A-Za-z0-9_-]{24}$/u.test(recoveryPublicTokenId)) return null;
    const rows = await allRows(
      this.#primarySession(),
      RECOVERABLE_ENROLLMENT_SELECT,
      [recoveryPublicTokenId]
    );
    if (rows.length > 1) fail("SERVICE_UNAVAILABLE");
    const row = rows[0];
    return row === undefined ? null : parseRecoverableEnrollment(row);
  }

  async createRecoverableEnrollmentAtomically(input: {
    readonly installation: InstallationRecord;
    readonly consentReceipt: ConsentReceiptRecord;
    readonly recoveryCredential: StoredCredential;
  }): Promise<void> {
    const installation = input.installation;
    const receipt = input.consentReceipt;
    const recovery = input.recoveryCredential;
    if (
      installation.status !== "active" ||
      installation.uploadCredential === null ||
      installation.deletionCredential === null ||
      receipt.installationId !== installation.installationId ||
      receipt.documentRevision !== installation.consentDocumentRevision ||
      recovery.scope !== "enrollment-recovery" ||
      !/^[A-Za-z0-9_-]{24}$/u.test(recovery.publicTokenId)
    ) {
      fail("INPUT_INVALID");
    }
    const requestId = this.#nextRequestId();
    await commitBatch(this.db, [
      guardHeader(this.db, requestId, "enrollment", this.#guardExpiry()),
      installationGuard(
        this.db,
        requestId,
        installation.installationId,
        null
      ),
      this.db.prepare(ENROLLMENT_INSTALL).bind(
        installation.installationId,
        installation.uploadCredential.publicTokenId,
        decodeCredentialDigest(installation.uploadCredential.hmacDigest),
        installation.uploadCredential.hmacKeyId,
        installation.deletionCredential.publicTokenId,
        decodeCredentialDigest(installation.deletionCredential.hmacDigest),
        installation.deletionCredential.hmacKeyId,
        installation.status,
        installation.consentDocumentRevision,
        installation.createdAt,
        installation.pausedAt,
        installation.deletingAt,
        installation.deletedAt
      ),
      this.db.prepare(CONSENT_INSERT).bind(
        receipt.eventId,
        receipt.installationId,
        receipt.documentRevision,
        receipt.acknowledgedAt,
        receipt.recordedAt,
        ACTIVE_CONSENT_EXPIRES_AT
      ),
      this.db.prepare(RECOVERABLE_ENROLLMENT_INSERT).bind(
        recovery.publicTokenId,
        decodeCredentialDigest(recovery.hmacDigest),
        recovery.hmacKeyId,
        installation.installationId,
        receipt.eventId,
        installation.createdAt
      ),
      guardCleanup(this.db, requestId)
    ]);
  }

  async findCredentialCandidate(
    scope: CredentialScope,
    publicTokenId: string
  ): Promise<CredentialCandidate | null> {
    if (!/^[A-Za-z0-9_-]{16,32}$/u.test(publicTokenId)) return null;
    const at = canonicalNow(this.#now);
    let session: D1MutationSessionLike;
    try {
      session = this.db.withSession("first-primary");
    } catch {
      fail("SERVICE_UNAVAILABLE");
    }
    return readCredentialCandidate(session, scope, publicTokenId, at);
  }

  async getDeletionJobStatus(
    jobId: string
  ): Promise<DeletionStatusRecord | null> {
    if (!/^del_[A-Za-z0-9_-]{22}$/u.test(jobId)) fail("INPUT_INVALID");
    const row = await firstRow(
      this.#primarySession(),
      DELETION_STATUS_BY_JOB_SELECT,
      [jobId]
    );
    return row === null ? null : parseDeletionStatus(row);
  }

  async listQueuedDeletionJobIds(
    limit: number
  ): Promise<readonly string[]> {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_QUEUED_DELETION_JOB_LIMIT
    ) {
      fail("INPUT_INVALID");
    }
    const rows = await allRows(
      this.#primarySession(),
      QUEUED_DELETION_JOB_IDS_SELECT,
      [limit]
    );
    if (rows.length > limit) fail("SERVICE_UNAVAILABLE");
    const jobIds = rows.map((row) => asString(row["jobId"]));
    if (
      jobIds.some((jobId) => !/^del_[A-Za-z0-9_-]{22}$/u.test(jobId)) ||
      new Set(jobIds).size !== jobIds.length
    ) {
      fail("SERVICE_UNAVAILABLE");
    }
    return Object.freeze(jobIds);
  }

  async withIngestTransaction<T>(
    installationId: string,
    operation: (transaction: IngestTransactionPort) => Promise<T>
  ): Promise<T> {
    const at = canonicalNow(this.#now);
    const session = this.#primarySession();
    const recorder = new IngestRecorder(
      this.db,
      session,
      installationId,
      at,
      this.#retentionDays,
      this.#nextRequestId(),
      this.#guardExpiry()
    );
    const result = await operation(recorder);
    await recorder.commit();
    return result;
  }

  async withLifecycleTransaction<T>(
    installationId: string,
    operation: (transaction: LifecycleTransactionPort) => Promise<T>
  ): Promise<T> {
    const at = canonicalNow(this.#now);
    const session = this.#primarySession();
    const recorder = new LifecycleRecorder(
      this.db,
      session,
      installationId,
      at,
      this.#nextRequestId(),
      this.#guardExpiry()
    );
    const result = await operation(recorder);
    await recorder.commit();
    return result;
  }

  async withDeletionTransaction<T>(
    installationId: string,
    operation: (transaction: DeletionTransactionPort) => Promise<T>
  ): Promise<T> {
    const at = canonicalNow(this.#now);
    const session = this.#primarySession();
    const recorder = new DeletionRecorder(
      this.db,
      session,
      installationId,
      at,
      this.#nextRequestId(),
      this.#guardExpiry()
    );
    const result = await operation(recorder);
    await recorder.commit();
    return result;
  }

  async completeDeletionAtomically(input: {
    readonly jobId: string;
    readonly completedAt: string;
  }): Promise<DeletionRequestRecord> {
    const session = this.#primarySession();
    const row = await firstRow(session, DELETION_BY_JOB_SELECT, [input.jobId]);
    if (row === null) fail("INPUT_INVALID");
    const deletion = parseDeletion(row);
    const installation = await readInstallation(
      session,
      deletion.record.installationId
    );
    if (installation === null) fail("SERVICE_UNAVAILABLE");
    if (
      (deletion.record.state === "complete" &&
        installation.record.status !== "deleted") ||
      ((deletion.record.state === "queued" ||
        deletion.record.state === "running") &&
        installation.record.status !== "deleting")
    ) {
      fail("SERVICE_UNAVAILABLE");
    }
    const requestId = this.#nextRequestId();
    const statements: D1MutationPreparedStatementLike[] = [
      guardHeader(
        this.db,
        requestId,
        "complete-delete",
        this.#guardExpiry()
      ),
      installationGuard(
        this.db,
        requestId,
        deletion.record.installationId,
        installation
      ),
      deletionGuard(
        this.db,
        requestId,
        deletion.record.installationId,
        deletion.record.idempotencyKey,
        deletion
      )
    ];
    if (deletion.record.state !== "complete") {
      if (
        deletion.record.state !== "queued" &&
        deletion.record.state !== "running"
      ) {
        fail("INPUT_INVALID");
      }
      statements.push(
        ...this.#purgeStatements(
          deletion.record.installationId,
          input.completedAt,
          deletion.record.expiresAt
        ),
        this.db.prepare(COMPLETE_JOB_UPDATE).bind(
          deletion.record.jobId,
          input.completedAt
        ),
        this.db.prepare(DIRTY_UPSERT).bind(input.completedAt, "delete")
      );
    }
    statements.push(guardCleanup(this.db, requestId));
    await commitBatch(this.db, statements);
    return deletion.record.state === "complete"
      ? deletion.record
      : Object.freeze({
          ...deletion.record,
          state: "complete" as const,
          completedAt: input.completedAt
        });
  }

  async *listRestoredInstallationIds(): AsyncIterable<string> {
    let cursor = "";
    for (;;) {
      const session = this.#primarySession();
      const rows = await allRows(session, INSTALLATION_PAGE_SELECT, [cursor, 100]);
      if (rows.length === 0) return;
      for (const row of rows) {
        const installationId = asString(row["installationId"]);
        if (installationId <= cursor) fail("SERVICE_UNAVAILABLE");
        cursor = installationId;
        yield installationId;
      }
      if (rows.length < 100) return;
    }
  }

  async purgeRestoredInstallation(
    installationId: string,
    at: string
  ): Promise<boolean> {
    const session = this.#primarySession();
    const installation = await readInstallation(session, installationId);
    if (installation === null) return false;
    const requestId = this.#nextRequestId();
    await commitBatch(this.db, [
      guardHeader(
        this.db,
        requestId,
        "restore-purge",
        this.#guardExpiry()
      ),
      installationGuard(
        this.db,
        requestId,
        installationId,
        installation
      ),
      // A backup must not revive an abandoned optimistic-guard snapshot.
      // Those rows can retain token HMACs, deletion-job verifiers, and other
      // installation-attributable metadata. Exclude this batch's live guard.
      this.db
        .prepare(DELETE_RESTORED_MUTATION_GUARDS)
        .bind(installationId, requestId),
      // A restored pre-completion job contains live status/replay verifiers.
      // It is not a deletion receipt in this isolated recovery path and must
      // disappear atomically with all other attributable restored state.
      this.db.prepare(DELETE_RESTORED_DELETION_JOBS).bind(installationId),
      ...this.#purgeStatements(
        installationId,
        at,
        addDays(at, this.#retentionDays)
      ),
      this.db.prepare(DIRTY_UPSERT).bind(at, "delete"),
      guardCleanup(this.db, requestId)
    ]);
    return true;
  }

  #purgeStatements(
    installationId: string,
    at: string,
    receiptExpiresAt: string
  ): readonly D1MutationPreparedStatementLike[] {
    return [
      this.db.prepare(DELETE_USAGE).bind(installationId),
      this.db.prepare(DELETE_AUTHORITIES).bind(installationId),
      this.db.prepare(DELETE_BATCHES).bind(installationId),
      this.db.prepare(DELETE_SHARES).bind(installationId),
      this.db.prepare(DELETE_CONSENT).bind(installationId),
      this.db.prepare(COMPLETE_INSTALLATION_UPDATE).bind(
        installationId,
        at,
        receiptExpiresAt
      )
    ];
  }

  #primarySession(): D1MutationSessionLike {
    try {
      return this.db.withSession("first-primary");
    } catch {
      fail("SERVICE_UNAVAILABLE");
    }
  }

  #nextRequestId(): string {
    let value: string;
    try {
      value = this.#createRequestId();
    } catch {
      fail("SERVICE_UNAVAILABLE");
    }
    return assertRequestId(value);
  }

  #guardExpiry(): string {
    const now = canonicalNow(this.#now);
    return new Date(Date.parse(now) + 5 * 60_000).toISOString();
  }
}

export function createD1MutationStorage(
  db: D1MutationDatabaseLike,
  options: D1MutationStorageOptions = {}
): D1MutationStorage {
  if (
    db === null ||
    typeof db !== "object" ||
    typeof db.prepare !== "function" ||
    typeof db.batch !== "function" ||
    typeof db.withSession !== "function" ||
    (options.identifiableRetentionDays !== undefined &&
      options.identifiableRetentionDays !== 30)
  ) {
    fail("INPUT_INVALID");
  }
  return Object.freeze(new CloudD1MutationStorage(db, options));
}
