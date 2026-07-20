import { randomBytes, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

import {
  DeletionAcceptedResponseV1Schema,
  DeletionStatusResponseV1Schema,
  DailyAggregateBucketV1Schema,
  EnrollmentResponseV1Schema,
  EnrollmentResponseV2Schema,
  IngestReceiptV1Schema,
  IngestSnapshotV1Schema,
  IngestSnapshotV2Schema,
  MAX_INGEST_BUCKETS_V1,
  MAX_INGEST_BUCKETS_V2,
  PauseResponseV1Schema,
  ResumeResponseV1Schema,
  SupportedIngestSnapshotSchema,
  type DailyAggregateBucketV1,
  type DeletionStatusResponseV1,
  type SupportedIngestSnapshot,
} from "@tokenmonster/contracts";
import type {
  EncryptedSecretSlot,
  SecretSlotStatus,
} from "@tokenmonster/secret-vault";
import type {
  StoredCloudMirrorRow,
  StoredDailyAggregate,
  MissingCloudZeroCorrectionPlan,
} from "@tokenmonster/local-store";

import type {
  ContributionActionResult,
  ContributionDeletionResult,
  ContributionPreview,
  ContributionRuntimeStatus,
  ContributionSyncResult,
} from "./types.js";

const DAY_MS = 86_400_000;
const MAX_RESPONSE_BYTES = 65_536;
const MAX_LOCAL_ROWS = 1_000;
const PREVIEW_LIFETIME_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
export const CONTRIBUTION_CREDENTIAL_OPERATION_TIMEOUT_MS = 10_000;
export const CONTRIBUTION_CONSENT_TITLE_MAX_LENGTH = 200;
export const CONTRIBUTION_CONSENT_SUMMARY_MAX_LENGTH = 2_000;
export const CONTRIBUTION_RETENTION_DISCLOSURE_MAX_LENGTH = 4_000;
const UPLOAD_TOKEN_PATTERN =
  /^(?:tm_u1_[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{43}|tm_u2_[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])$/u;
const DELETION_TOKEN_PATTERN =
  /^(?:tm_d1_[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{43}|tm_d2_[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])$/u;
const UPLOAD_TOKEN_V2_PATTERN =
  /^tm_u2_[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const DELETION_TOKEN_V2_PATTERN =
  /^tm_d2_[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const RECOVERY_TOKEN_V2_PATTERN =
  /^tm_r2_[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const STATUS_TOKEN_PATTERN = /^tm_s1_[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{43}$/u;
const JOB_ID_PATTERN = /^del_[A-Za-z0-9_-]{22}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONSENT_REVISION_PATTERN =
  /^contribution-20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u;
const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;
const PROBLEM_JSON_CONTENT_TYPE_PATTERN =
  /^application\/problem\+json(?:\s*;\s*charset=utf-8)?$/u;

export const CONTRIBUTION_FIELD_ALLOWLIST = Object.freeze([
  "schemaVersion",
  "batchId",
  "generatedAt",
  "collector.kind",
  "collector.adapterVersion",
  "collector.sourceVersion",
  "buckets.bucketStart",
  "buckets.provider",
  "buckets.modelFamily",
  "buckets.tool",
  "buckets.valueQuality",
  "buckets.revision",
  "buckets.tokens.input",
  "buckets.tokens.output",
  "buckets.tokens.cacheRead",
  "buckets.tokens.cacheWrite",
  "buckets.tokens.reasoning",
  "buckets.tokens.other",
  "buckets.tokens.total",
] as const);

export const PRODUCTION_CONTRIBUTION_API_ORIGINS = Object.freeze([
  "https://tokenmonster.app",
  "https://api.tokenmonster.app",
] as const);

type FetchPort = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface ContributionStorePort {
  listDailyAggregates(input: {
    readonly fromInclusive: string;
    readonly toExclusive: string;
    readonly limit: number;
  }): readonly StoredDailyAggregate[];
  getCompleteDailyScanCoverage(input: {
    readonly utcDate: string;
  }): Readonly<{ readonly complete: boolean }>;
  listCloudMirror(input: {
    readonly fromInclusive: string;
    readonly toExclusive: string;
    readonly limit: number;
  }): readonly StoredCloudMirrorRow[];
  planMissingCloudZeroCorrections(
    input: Readonly<{
      bucketStart: string;
      completeScan: true;
      collector: StoredDailyAggregate["collector"];
      presentKeys: readonly Readonly<{
        provider: DailyAggregateBucketV1["provider"];
        modelFamily: string;
        tool: string;
      }>[];
      limit: number;
    }>,
  ): MissingCloudZeroCorrectionPlan;
  enqueueCloudSnapshot(
    snapshot: unknown,
    options: Readonly<{ nextAttemptAt: string; expiresAt: string }>,
  ): "inserted" | "idempotent";
  listDueCloudSnapshots(input: {
    readonly now: string;
    readonly limit: number;
  }): readonly Readonly<{
    snapshot: SupportedIngestSnapshot;
    attempts: number;
    expiresAt: string;
  }>[];
  rescheduleCloudSnapshot(
    input: Readonly<{
      batchId: string;
      nextAttemptAt: string;
      errorCode:
        | "network"
        | "timeout"
        | "rate-limited"
        | "server-unavailable"
        | "clock-skew";
    }>,
  ): boolean;
  recordAcceptedCloudSnapshot(snapshot: unknown, receipt: unknown): unknown;
  markCloudSnapshotDelivered(batchId: string): boolean;
  purgeExpiredCloudSnapshots(now: string): number;
  clearCloudOutbox(): number;
  clearCloudMirror(input: { readonly limit: number }): number;
  getDiagnosticSummary(): Readonly<{
    counts: Readonly<{
      cloudOutboxEntries: number;
      cloudMirrorEntries: number;
    }>;
  }>;
}

interface ContributionServiceOptions {
  readonly store: ContributionStorePort;
  readonly uploadCredential: EncryptedSecretSlot;
  readonly deletionCredential: EncryptedSecretSlot;
  readonly statusCredential: EncryptedSecretSlot;
  /** One atomic OS-vault record for the complete pre-request V2 enrollment. */
  readonly pendingEnrollmentCredential: EncryptedSecretSlot;
  readonly configuredBaseUrl: unknown;
  readonly allowedOrigins?: readonly string[];
  readonly fetcher?: FetchPort;
  readonly clock?: () => Date;
  readonly uuid?: () => string;
  /** Deterministic tests only. Production uses node:crypto randomBytes. */
  readonly credentialBytes?: (size: 18 | 32) => Uint8Array;
}

interface StoredUploadCredential {
  readonly token: string;
  readonly consentDocumentRevision: string;
  readonly lifecycle: "active" | "pause-pending" | "paused" | "resume-pending";
}

interface StoredDeletionCredential {
  readonly token: string;
  readonly idempotencyKey: string;
}

interface StoredStatusCredential {
  readonly token: string;
  readonly jobId: string;
  readonly status: DeletionStatusResponseV1["status"];
  readonly requestedAt: string;
  readonly finishedAt: string | null;
}

interface StoredPendingEnrollment {
  readonly uploadToken: string;
  readonly deletionToken: string;
  readonly recoveryToken: string;
  readonly deletionIdempotencyKey: string;
  readonly consent: Readonly<{
    purpose: "contribution";
    documentRevision: string;
    granted: true;
    acknowledgedAt: string;
  }>;
}

interface VerifiedConsentDocument {
  readonly revision: string;
  readonly title: string;
  readonly summary: string;
  readonly retentionDisclosure: string;
}

interface PendingPreview {
  readonly createdAtMs: number;
  readonly preview: ContributionPreview;
  readonly snapshot: SupportedIngestSnapshot | null;
}

type RetryCode =
  "network" | "timeout" | "rate-limited" | "server-unavailable" | "clock-skew";

class ContributionServiceError extends Error {
  override readonly name = "ContributionServiceError";
  constructor(readonly code: ContributionActionResult["code"]) {
    super(code);
  }
}

function strictRecord(value: unknown): Record<string, unknown> | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    return null;
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(record);
  return (
    keys.length === expected.length &&
    keys.every((key) => typeof key === "string" && expected.includes(key))
  );
}

function canonicalNow(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new ContributionServiceError("local-service-error");
  }
  return new Date(value.getTime());
}

function generatedUuid(uuid: () => string): string {
  const value = uuid();
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new ContributionServiceError("local-service-error");
  }
  return value;
}

function validConsentText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maximum &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  );
}

function isConsentRequiredProblem(value: unknown): boolean {
  const problem = strictRecord(value);
  return (
    problem !== null &&
    exactKeys(problem, [
      "type",
      "title",
      "status",
      "detail",
      "code",
      "requestId",
    ]) &&
    problem["type"] === "about:blank" &&
    validConsentText(problem["title"], 256) &&
    problem["status"] === 403 &&
    validConsentText(problem["detail"], 2_048) &&
    problem["code"] === "CONSENT_REQUIRED" &&
    typeof problem["requestId"] === "string" &&
    SAFE_REQUEST_ID_PATTERN.test(problem["requestId"])
  );
}

export function resolveContributionApiBaseUrl(
  input: unknown,
  allowedOrigins: readonly string[] = PRODUCTION_CONTRIBUTION_API_ORIGINS,
): string | null {
  if (
    typeof input !== "string" ||
    input.length < 1 ||
    input.length > 2_048 ||
    input.includes("\0") ||
    !Array.isArray(allowedOrigins)
  ) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    !allowedOrigins.includes(parsed.origin)
  ) {
    return null;
  }
  return parsed.origin;
}

function serializeUploadCredential(input: StoredUploadCredential): string {
  return JSON.stringify({
    schemaVersion: 2,
    kind: "upload",
    token: input.token,
    consentDocumentRevision: input.consentDocumentRevision,
    lifecycle: input.lifecycle,
  });
}

function parseUploadCredential(
  input: string | null,
): StoredUploadCredential | null {
  if (input === null) return null;
  try {
    const record = strictRecord(JSON.parse(input) as unknown);
    if (
      record === null ||
      record["kind"] !== "upload" ||
      typeof record["token"] !== "string" ||
      !UPLOAD_TOKEN_PATTERN.test(record["token"]) ||
      typeof record["consentDocumentRevision"] !== "string" ||
      !CONSENT_REVISION_PATTERN.test(record["consentDocumentRevision"])
    ) {
      return null;
    }
    if (
      record["schemaVersion"] === 1 &&
      exactKeys(record, [
        "schemaVersion",
        "kind",
        "token",
        "consentDocumentRevision",
      ])
    ) {
      return Object.freeze({
        token: record["token"],
        consentDocumentRevision: record["consentDocumentRevision"],
        lifecycle: "active" as const,
      });
    }
    if (
      record["schemaVersion"] === 2 &&
      exactKeys(record, [
        "schemaVersion",
        "kind",
        "token",
        "consentDocumentRevision",
        "lifecycle",
      ]) &&
      (record["lifecycle"] === "active" ||
        record["lifecycle"] === "pause-pending" ||
        record["lifecycle"] === "paused" ||
        record["lifecycle"] === "resume-pending")
    ) {
      return Object.freeze({
        token: record["token"],
        consentDocumentRevision: record["consentDocumentRevision"],
        lifecycle: record["lifecycle"],
      });
    }
    return null;
  } catch {
    return null;
  }
}

function serializeDeletionCredential(input: StoredDeletionCredential): string {
  return JSON.stringify({
    schemaVersion: 1,
    kind: "deletion",
    token: input.token,
    idempotencyKey: input.idempotencyKey,
  });
}

function parseDeletionCredential(
  input: string | null,
): StoredDeletionCredential | null {
  if (input === null) return null;
  try {
    const record = strictRecord(JSON.parse(input) as unknown);
    if (
      record === null ||
      !exactKeys(record, [
        "schemaVersion",
        "kind",
        "token",
        "idempotencyKey",
      ]) ||
      record["schemaVersion"] !== 1 ||
      record["kind"] !== "deletion" ||
      typeof record["token"] !== "string" ||
      !DELETION_TOKEN_PATTERN.test(record["token"]) ||
      typeof record["idempotencyKey"] !== "string" ||
      !UUID_PATTERN.test(record["idempotencyKey"])
    ) {
      return null;
    }
    return Object.freeze({
      token: record["token"],
      idempotencyKey: record["idempotencyKey"],
    });
  } catch {
    return null;
  }
}

function serializeStatusCredential(input: StoredStatusCredential): string {
  return JSON.stringify({
    schemaVersion: 1,
    kind: "deletion-status",
    token: input.token,
    jobId: input.jobId,
    status: input.status,
    requestedAt: input.requestedAt,
    finishedAt: input.finishedAt,
  });
}

function serializePendingEnrollment(input: StoredPendingEnrollment): string {
  return JSON.stringify({
    schemaVersion: 1,
    kind: "recoverable-enrollment",
    uploadToken: input.uploadToken,
    deletionToken: input.deletionToken,
    recoveryToken: input.recoveryToken,
    deletionIdempotencyKey: input.deletionIdempotencyKey,
    consent: input.consent,
  });
}

function parsePendingEnrollment(
  input: string | null,
): StoredPendingEnrollment | null {
  if (input === null) return null;
  try {
    const record = strictRecord(JSON.parse(input) as unknown);
    const consent = record === null ? null : strictRecord(record["consent"]);
    if (
      record === null ||
      !exactKeys(record, [
        "schemaVersion",
        "kind",
        "uploadToken",
        "deletionToken",
        "recoveryToken",
        "deletionIdempotencyKey",
        "consent",
      ]) ||
      record["schemaVersion"] !== 1 ||
      record["kind"] !== "recoverable-enrollment" ||
      typeof record["uploadToken"] !== "string" ||
      !UPLOAD_TOKEN_V2_PATTERN.test(record["uploadToken"]) ||
      typeof record["deletionToken"] !== "string" ||
      !DELETION_TOKEN_V2_PATTERN.test(record["deletionToken"]) ||
      typeof record["recoveryToken"] !== "string" ||
      !RECOVERY_TOKEN_V2_PATTERN.test(record["recoveryToken"]) ||
      typeof record["deletionIdempotencyKey"] !== "string" ||
      !UUID_PATTERN.test(record["deletionIdempotencyKey"]) ||
      consent === null ||
      !exactKeys(consent, [
        "purpose",
        "documentRevision",
        "granted",
        "acknowledgedAt",
      ]) ||
      consent["purpose"] !== "contribution" ||
      typeof consent["documentRevision"] !== "string" ||
      !CONSENT_REVISION_PATTERN.test(consent["documentRevision"]) ||
      consent["granted"] !== true ||
      typeof consent["acknowledgedAt"] !== "string"
    ) {
      return null;
    }
    const canonicalAcknowledgedAt = new Date(
      consent["acknowledgedAt"],
    ).toISOString();
    if (canonicalAcknowledgedAt !== consent["acknowledgedAt"]) return null;
    const tokens = [
      record["uploadToken"],
      record["deletionToken"],
      record["recoveryToken"],
    ];
    const publicIds = tokens.map((token) =>
      token.slice("tm_u2_".length, token.indexOf(".")),
    );
    const secrets = tokens.map((token) => token.slice(token.indexOf(".") + 1));
    if (new Set(publicIds).size !== 3 || new Set(secrets).size !== 3) {
      return null;
    }
    return Object.freeze({
      uploadToken: record["uploadToken"],
      deletionToken: record["deletionToken"],
      recoveryToken: record["recoveryToken"],
      deletionIdempotencyKey: record["deletionIdempotencyKey"],
      consent: Object.freeze({
        purpose: "contribution" as const,
        documentRevision: consent["documentRevision"],
        granted: true as const,
        acknowledgedAt: consent["acknowledgedAt"],
      }),
    });
  } catch {
    return null;
  }
}

function generatedCredentialBytes(
  source: (size: 18 | 32) => Uint8Array,
  size: 18 | 32,
): Uint8Array {
  const bytes = source(size);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== size) {
    throw new ContributionServiceError("local-service-error");
  }
  return new Uint8Array(bytes);
}

function generatePendingEnrollment(
  consent: StoredPendingEnrollment["consent"],
  deletionIdempotencyKey: string,
  source: (size: 18 | 32) => Uint8Array,
): StoredPendingEnrollment {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const pairs = Array.from({ length: 3 }, () => ({
      publicId: Buffer.from(generatedCredentialBytes(source, 18)).toString(
        "base64url",
      ),
      secret: Buffer.from(generatedCredentialBytes(source, 32)).toString(
        "base64url",
      ),
    }));
    if (
      new Set(pairs.map(({ publicId }) => publicId)).size !== 3 ||
      new Set(pairs.map(({ secret }) => secret)).size !== 3
    ) {
      continue;
    }
    return Object.freeze({
      uploadToken: `tm_u2_${pairs[0]!.publicId}.${pairs[0]!.secret}`,
      deletionToken: `tm_d2_${pairs[1]!.publicId}.${pairs[1]!.secret}`,
      recoveryToken: `tm_r2_${pairs[2]!.publicId}.${pairs[2]!.secret}`,
      deletionIdempotencyKey,
      consent: Object.freeze({ ...consent }),
    });
  }
  throw new ContributionServiceError("local-service-error");
}

function parseStatusCredential(
  input: string | null,
): StoredStatusCredential | null {
  if (input === null) return null;
  try {
    const record = strictRecord(JSON.parse(input) as unknown);
    if (
      record === null ||
      !exactKeys(record, [
        "schemaVersion",
        "kind",
        "token",
        "jobId",
        "status",
        "requestedAt",
        "finishedAt",
      ]) ||
      record["schemaVersion"] !== 1 ||
      record["kind"] !== "deletion-status" ||
      typeof record["token"] !== "string" ||
      !STATUS_TOKEN_PATTERN.test(record["token"]) ||
      typeof record["jobId"] !== "string" ||
      !JOB_ID_PATTERN.test(record["jobId"])
    ) {
      return null;
    }
    const parsed = DeletionStatusResponseV1Schema.safeParse({
      contractVersion: 1,
      jobId: record["jobId"],
      status: record["status"],
      requestedAt: record["requestedAt"],
      finishedAt: record["finishedAt"],
      anonymousHistoricalTotalsRetained: true,
    });
    if (!parsed.success) return null;
    return Object.freeze({
      token: record["token"],
      jobId: parsed.data.jobId,
      status: parsed.data.status,
      requestedAt: parsed.data.requestedAt,
      finishedAt: parsed.data.finishedAt,
    });
  } catch {
    return null;
  }
}

function parseConsentDocument(input: unknown): VerifiedConsentDocument {
  const record = strictRecord(input);
  const retention = record === null ? null : strictRecord(record["retention"]);
  const controls = record === null ? null : strictRecord(record["controls"]);
  const allowlist = record?.["fieldAllowlist"];
  if (
    record === null ||
    record["contractVersion"] !== 1 ||
    record["purpose"] !== "contribution" ||
    record["locale"] !== "zh-TW" ||
    typeof record["revision"] !== "string" ||
    !CONSENT_REVISION_PATTERN.test(record["revision"]) ||
    !validConsentText(record["title"], CONTRIBUTION_CONSENT_TITLE_MAX_LENGTH) ||
    !validConsentText(
      record["summary"],
      CONTRIBUTION_CONSENT_SUMMARY_MAX_LENGTH,
    ) ||
    !Array.isArray(allowlist) ||
    allowlist.length !== CONTRIBUTION_FIELD_ALLOWLIST.length ||
    allowlist.some(
      (field, index) => field !== CONTRIBUTION_FIELD_ALLOWLIST[index],
    ) ||
    retention === null ||
    retention["identifiableCurrentBucketsMaximumDays"] !== 30 ||
    !validConsentText(
      retention["disclosure"],
      CONTRIBUTION_RETENTION_DISCLOSURE_MAX_LENGTH,
    ) ||
    controls === null ||
    controls["defaultEnabled"] !== false ||
    controls["pauseStopsFutureUploadsButDoesNotDelete"] !== true ||
    controls["deletionRemovesIdentifiableCurrentData"] !== true ||
    controls["productAnalyticsIsSeparateAndDefaultOff"] !== true
  ) {
    throw new ContributionServiceError("contract-mismatch");
  }
  return Object.freeze({
    revision: record["revision"],
    title: record["title"],
    summary: record["summary"],
    retentionDisclosure: retention["disclosure"],
  });
}

async function readBoundedJson(
  response: Response,
  allowProblem = false,
): Promise<unknown> {
  const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? "";
  const accepted = allowProblem
    ? /^application\/(?:json|problem\+json)(?:\s*;\s*charset=utf-8)?$/u
    : /^application\/json(?:\s*;\s*charset=utf-8)?$/u;
  if (!accepted.test(contentType)) {
    throw new ContributionServiceError("contract-mismatch");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new ContributionServiceError("contract-mismatch");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let chunkCount = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      chunkCount += 1;
      if (
        chunkCount > 1_024 ||
        part.value.byteLength === 0 ||
        part.value.byteLength > MAX_RESPONSE_BYTES - total
      ) {
        void reader.cancel().catch(() => undefined);
        throw new ContributionServiceError("contract-mismatch");
      }
      total += part.value.byteLength;
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) {
    throw new ContributionServiceError("contract-mismatch");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new ContributionServiceError("contract-mismatch");
  }
}

function sameCollector(
  left: StoredDailyAggregate["collector"],
  right: StoredDailyAggregate["collector"],
): boolean {
  return (
    left.kind === right.kind &&
    left.adapterVersion === right.adapterVersion &&
    left.sourceVersion === right.sourceVersion
  );
}

function bucketKey(
  bucket: Pick<
    DailyAggregateBucketV1,
    "bucketStart" | "provider" | "modelFamily" | "tool"
  >,
): string {
  return [
    bucket.bucketStart,
    bucket.provider,
    bucket.modelFamily,
    bucket.tool,
  ].join("|");
}

function sameWireValue(
  local: StoredDailyAggregate,
  mirror: StoredCloudMirrorRow,
): boolean {
  return (
    local.valueQuality === mirror.bucket.valueQuality &&
    sameCollector(local.collector, mirror.collector) &&
    Object.keys(local.tokens).every(
      (field) =>
        local.tokens[field as keyof typeof local.tokens] ===
        mirror.bucket.tokens[field as keyof typeof mirror.bucket.tokens],
    )
  );
}

function eligibleBuckets(
  store: ContributionStorePort,
  now: Date,
): readonly DailyAggregateBucketV1[] {
  // Only closed UTC days are eligible. Today's still-changing absolute totals
  // stay local even when all four explicit scans have already run.
  const toExclusive = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
  const fromInclusive = new Date(
    Date.parse(toExclusive) - 29 * DAY_MS,
  ).toISOString();
  const rows = store.listDailyAggregates({
    fromInclusive,
    toExclusive,
    limit: MAX_LOCAL_ROWS,
  });
  if (rows.length >= MAX_LOCAL_ROWS) {
    throw new ContributionServiceError("local-data-too-large");
  }
  const mirrorRows = store.listCloudMirror({
    fromInclusive,
    toExclusive,
    limit: MAX_LOCAL_ROWS,
  });
  if (mirrorRows.length >= MAX_LOCAL_ROWS) {
    throw new ContributionServiceError("local-data-too-large");
  }
  const rawRowsByDay = new Map<string, StoredDailyAggregate[]>();
  for (const row of rows) {
    const dayRows = rawRowsByDay.get(row.bucketStart) ?? [];
    dayRows.push(row);
    rawRowsByDay.set(row.bucketStart, dayRows);
  }
  const mirrorsByDay = new Map<string, StoredCloudMirrorRow[]>();
  for (const mirror of mirrorRows) {
    const dayMirrors = mirrorsByDay.get(mirror.bucket.bucketStart) ?? [];
    dayMirrors.push(mirror);
    mirrorsByDay.set(mirror.bucket.bucketStart, dayMirrors);
  }
  const allDayStarts = new Set([
    ...rawRowsByDay.keys(),
    ...mirrorRows.map((row) => row.bucket.bucketStart),
  ]);
  const eligibleDayStarts = new Set(
    [...allDayStarts].filter((bucketStart) => {
      const dayRows = rawRowsByDay.get(bucketStart) ?? [];
      if (!dayRows.every((row) => row.localCoverage === "complete")) {
        return false;
      }
      const dayMirrors = mirrorsByDay.get(bucketStart) ?? [];
      const hasSidecarAuthority = [...dayRows, ...dayMirrors].some(
        (row) => row.collector.kind === "tokentracker-sidecar",
      );
      if (hasSidecarAuthority) {
        // A closed-range sidecar projection is its own complete authority
        // evidence. Mirror-only days are never promoted without a current
        // local projection proving the closed day was observed.
        return dayRows.length > 0;
      }
      // Legacy V1 collectors retain the four-client completeness contract.
      return store.getCompleteDailyScanCoverage({
        utcDate: bucketStart.slice(0, 10),
      }).complete;
    }),
  );
  const eligible = rows.filter((row) => eligibleDayStarts.has(row.bucketStart));
  const participatingCollectors = [
    ...eligible.map((row) => row.collector),
    ...mirrorRows
      .filter((row) => eligibleDayStarts.has(row.bucket.bucketStart))
      .map((row) => row.collector),
  ];
  const collector = participatingCollectors[0];
  if (
    collector !== undefined &&
    participatingCollectors.some(
      (candidate) => !sameCollector(candidate, collector),
    )
  ) {
    throw new ContributionServiceError("authority-conflict");
  }
  const mirrors = new Map(
    mirrorRows.map((row) => [bucketKey(row.bucket), row]),
  );
  const candidates = new Map<string, DailyAggregateBucketV1>();
  for (const row of eligible) {
    const mirror = mirrors.get(bucketKey(row));
    if (mirror !== undefined && sameWireValue(row, mirror)) continue;
    if (
      mirror !== undefined &&
      !sameCollector(row.collector, mirror.collector)
    ) {
      throw new ContributionServiceError("authority-conflict");
    }
    const revision =
      mirror === undefined
        ? row.revision
        : Math.max(row.revision, mirror.bucket.revision + 1);
    const bucket = DailyAggregateBucketV1Schema.parse({
      bucketStart: row.bucketStart,
      provider: row.provider,
      modelFamily: row.modelFamily,
      tool: row.tool,
      valueQuality: row.valueQuality,
      revision,
      tokens: row.tokens,
    });
    candidates.set(bucketKey(bucket), bucket);
  }

  const rowsByDay = new Map<string, StoredDailyAggregate[]>();
  for (const row of eligible) {
    const rowsForDay = rowsByDay.get(row.bucketStart) ?? [];
    rowsForDay.push(row);
    rowsByDay.set(row.bucketStart, rowsForDay);
  }
  const dayStarts = new Set([...rowsByDay.keys(), ...mirrorsByDay.keys()]);
  for (const bucketStart of dayStarts) {
    if (!eligibleDayStarts.has(bucketStart)) continue;
    const dayRows = rowsByDay.get(bucketStart) ?? [];
    const dayMirrors = mirrorsByDay.get(bucketStart) ?? [];
    const authority = dayRows[0]?.collector ?? dayMirrors[0]?.collector;
    if (
      authority === undefined ||
      dayRows.some((row) => !sameCollector(row.collector, authority)) ||
      dayMirrors.some((row) => !sameCollector(row.collector, authority))
    ) {
      throw new ContributionServiceError("authority-conflict");
    }
    const plan = store.planMissingCloudZeroCorrections({
      bucketStart,
      completeScan: true,
      collector: authority,
      presentKeys: Object.freeze(
        dayRows
          .filter((row) => row.tokens.total !== "0")
          .map((row) =>
            Object.freeze({
              provider: row.provider,
              modelFamily: row.modelFamily,
              tool: row.tool,
            }),
          ),
      ),
      limit:
        authority.kind === "tokentracker-sidecar"
          ? MAX_INGEST_BUCKETS_V2
          : MAX_INGEST_BUCKETS_V1,
    });
    if (plan.truncated) {
      throw new ContributionServiceError("local-data-too-large");
    }
    for (const correction of plan.corrections) {
      if (!sameCollector(correction.collector, authority)) {
        throw new ContributionServiceError("authority-conflict");
      }
      const key = bucketKey(correction.bucket);
      const current = candidates.get(key);
      if (
        current === undefined ||
        current.revision < correction.bucket.revision
      ) {
        candidates.set(key, correction.bucket);
      }
    }
  }
  return Object.freeze(
    [...candidates.values()].sort((left, right) =>
      bucketKey(left).localeCompare(bucketKey(right)),
    ),
  );
}

function snapshotExpiresAt(snapshot: SupportedIngestSnapshot): string {
  const expiryMs = Math.min(
    ...snapshot.buckets.map(
      (bucket) => Date.parse(bucket.bucketStart) + 30 * DAY_MS,
    ),
  );
  if (
    !Number.isFinite(expiryMs) ||
    expiryMs <= Date.parse(snapshot.generatedAt)
  ) {
    throw new ContributionServiceError("preview-expired");
  }
  return new Date(expiryMs).toISOString();
}

function buildSnapshot(
  store: ContributionStorePort,
  now: Date,
  uuid: () => string,
): Readonly<{
  snapshot: SupportedIngestSnapshot | null;
  totalEligibleBuckets: number;
}> {
  const buckets = eligibleBuckets(store, now);
  if (buckets.length === 0) {
    return Object.freeze({ snapshot: null, totalEligibleBuckets: 0 });
  }
  const firstBucket = buckets[0]!;
  const firstRow = store
    .listDailyAggregates({
      fromInclusive: firstBucket.bucketStart,
      toExclusive: new Date(
        Date.parse(firstBucket.bucketStart) + DAY_MS,
      ).toISOString(),
      limit: MAX_LOCAL_ROWS,
    })
    .find((row) => bucketKey(row) === bucketKey(firstBucket));
  const firstMirror =
    firstRow === undefined
      ? store
          .listCloudMirror({
            fromInclusive: firstBucket.bucketStart,
            toExclusive: new Date(
              Date.parse(firstBucket.bucketStart) + DAY_MS,
            ).toISOString(),
            limit: MAX_LOCAL_ROWS,
          })
          .find((row) => bucketKey(row.bucket) === bucketKey(firstBucket))
      : undefined;
  const collector = firstRow?.collector ?? firstMirror?.collector;
  if (collector === undefined) {
    throw new ContributionServiceError("local-service-error");
  }
  const limit =
    collector.kind === "tokentracker-sidecar"
      ? MAX_INGEST_BUCKETS_V2
      : MAX_INGEST_BUCKETS_V1;
  const selected = buckets.slice(0, limit);
  const envelope = {
    batchId: generatedUuid(uuid),
    generatedAt: now.toISOString(),
    collector,
    buckets: selected,
  };
  const snapshot =
    collector.kind === "tokentracker-sidecar"
      ? IngestSnapshotV2Schema.parse({ schemaVersion: "2", ...envelope })
      : IngestSnapshotV1Schema.parse({ schemaVersion: "1", ...envelope });
  if (
    new TextEncoder().encode(JSON.stringify(snapshot)).byteLength >
    MAX_RESPONSE_BYTES
  ) {
    throw new ContributionServiceError("local-data-too-large");
  }
  return Object.freeze({ snapshot, totalEligibleBuckets: buckets.length });
}

function nextRetryAt(
  now: Date,
  attempts: number,
  expiresAt: string,
): string | null {
  const delayMs = Math.min(
    6 * 60 * 60_000,
    60_000 * 2 ** Math.min(attempts, 8),
  );
  const next = now.getTime() + delayMs;
  return next >= Date.parse(expiresAt) ? null : new Date(next).toISOString();
}

function clearContributionSyncState(store: ContributionStorePort): void {
  store.clearCloudOutbox();
  for (let batch = 0; batch < 1_000; batch += 1) {
    const removed = store.clearCloudMirror({ limit: 1_000 });
    if (removed < 1_000) return;
  }
  throw new ContributionServiceError("local-data-too-large");
}

export interface ContributionService {
  initialize(): Promise<void>;
  dispose(): void;
  quiesce(): Promise<void>;
  status(): ContributionRuntimeStatus;
  preparePreview(): Promise<ContributionPreview>;
  enable(previewId: string): Promise<ContributionActionResult>;
  sync(): Promise<ContributionSyncResult>;
  stop(): Promise<ContributionActionResult>;
  requestDeletion(): Promise<ContributionDeletionResult>;
  refreshDeletionStatus(): Promise<ContributionDeletionResult>;
  /**
   * Retries only an already-durable ambiguous enrollment or an in-flight
   * deletion status lookup. It never creates consent or credentials.
   */
  recover(): Promise<ContributionActionResult>;
}

export function createContributionService(
  options: ContributionServiceOptions,
): ContributionService {
  const baseUrl = resolveContributionApiBaseUrl(
    options.configuredBaseUrl,
    options.allowedOrigins ?? PRODUCTION_CONTRIBUTION_API_ORIGINS,
  );
  const fetcher = options.fetcher ?? globalThis.fetch;
  const clock = options.clock ?? (() => new Date());
  const uuid = options.uuid ?? randomUUID;
  const credentialBytes =
    options.credentialBytes ?? ((size: 18 | 32) => randomBytes(size));
  let initialized = false;
  let storageReady = false;
  let localStateReady = true;
  let pendingPreview: PendingPreview | null = null;
  let activeRequest: Readonly<{
    controller: AbortController;
    abortOnStop: boolean;
  }> | null = null;
  let busy = false;
  let localCleanupRequired = false;
  let uploadBlockedUntilRestart = false;
  let disposed = false;

  const credentialOperation = async <T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort("credential-operation-timeout");
        reject(new ContributionServiceError("secure-storage-failed"));
      }, CONTRIBUTION_CREDENTIAL_OPERATION_TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => operation(controller.signal)),
        deadline,
      ]);
    } finally {
      if (timeout !== null) clearTimeout(timeout);
    }
  };

  const initializeCredential = (slot: EncryptedSecretSlot) =>
    credentialOperation((signal) => slot.initialize({ signal }));
  const setCredential = (slot: EncryptedSecretSlot, value: string) =>
    credentialOperation((signal) => slot.set(value, { signal }));
  const clearCredential = (slot: EncryptedSecretSlot) =>
    credentialOperation((signal) => slot.clear({ signal }));

  const clearDeletionSupersededAuthorities = async (): Promise<void> => {
    const cleared = await Promise.allSettled([
      clearCredential(options.uploadCredential),
      clearCredential(options.deletionCredential),
    ]);
    if (cleared.some((result) => result.status === "rejected")) {
      throw new ContributionServiceError("secure-storage-failed");
    }
    try {
      options.store.clearCloudOutbox();
    } catch {
      throw new ContributionServiceError("local-service-error");
    }
  };

  const credentialState = () => {
    const rawUpload = options.uploadCredential.get();
    const rawDeletion = options.deletionCredential.get();
    const rawStatus = options.statusCredential.get();
    const rawPending = options.pendingEnrollmentCredential.get();
    return Object.freeze({
      rawUpload,
      rawDeletion,
      rawStatus,
      rawPending,
      upload: parseUploadCredential(rawUpload),
      deletion: parseDeletionCredential(rawDeletion),
      deletionStatus: parseStatusCredential(rawStatus),
      pendingEnrollment: parsePendingEnrollment(rawPending),
    });
  };

  const pendingMatchesActive = (
    pending: StoredPendingEnrollment,
    upload: StoredUploadCredential | null,
    deletion: StoredDeletionCredential | null,
  ): boolean =>
    upload !== null &&
    deletion !== null &&
    upload.token === pending.uploadToken &&
    upload.consentDocumentRevision === pending.consent.documentRevision &&
    deletion.token === pending.deletionToken &&
    deletion.idempotencyKey === pending.deletionIdempotencyKey;

  const status = (): ContributionRuntimeStatus => {
    const credentials = credentialState();
    const uploadCredentialCorrupt =
      credentials.rawUpload !== null && credentials.upload === null;
    const deletionCredentialCorrupt =
      credentials.rawDeletion !== null && credentials.deletion === null;
    const statusCredentialCorrupt =
      credentials.rawStatus !== null && credentials.deletionStatus === null;
    const pendingCredentialCorrupt =
      credentials.rawPending !== null && credentials.pendingEnrollment === null;
    const pendingActiveMismatch =
      credentials.pendingEnrollment !== null &&
      (credentials.rawUpload !== null || credentials.rawDeletion !== null) &&
      !pendingMatchesActive(
        credentials.pendingEnrollment,
        credentials.upload,
        credentials.deletion,
      ) &&
      !(
        credentials.upload?.token ===
          credentials.pendingEnrollment.uploadToken &&
        credentials.rawDeletion === null
      ) &&
      !(
        credentials.deletion?.token ===
          credentials.pendingEnrollment.deletionToken &&
        credentials.rawUpload === null
      );
    const unresolvedPendingEnrollment =
      credentials.pendingEnrollment !== null &&
      !pendingMatchesActive(
        credentials.pendingEnrollment,
        credentials.upload,
        credentials.deletion,
      );
    const localSyncState = (() => {
      try {
        const counts = options.store.getDiagnosticSummary().counts;
        return Object.freeze({
          outboxPending:
            Number.isSafeInteger(counts.cloudOutboxEntries) &&
            counts.cloudOutboxEntries >= 0
              ? counts.cloudOutboxEntries
              : 0,
          mirrorPending:
            !Number.isSafeInteger(counts.cloudMirrorEntries) ||
            counts.cloudMirrorEntries < 0 ||
            counts.cloudMirrorEntries > 0,
        });
      } catch {
        return Object.freeze({ outboxPending: 0, mirrorPending: true });
      }
    })();
    const outboxPending = localSyncState.outboxPending;
    const baseOperational =
      initialized && storageReady && localStateReady && baseUrl !== null;
    const contributionOperational =
      baseOperational &&
      !uploadCredentialCorrupt &&
      !deletionCredentialCorrupt &&
      !statusCredentialCorrupt &&
      !pendingCredentialCorrupt &&
      !pendingActiveMismatch &&
      !unresolvedPendingEnrollment &&
      !(
        credentials.upload !== null &&
        credentials.deletion === null &&
        credentials.deletionStatus === null
      );
    // Deletion authority is intentionally independent from upload authority.
    // A malformed upload slot must fail closed for upload without stranding a
    // still-valid deletion credential.
    const deletionOperational =
      baseOperational &&
      credentials.deletion !== null &&
      credentials.rawStatus === null &&
      !unresolvedPendingEnrollment;
    const deletionStatusOperational =
      baseOperational &&
      credentials.deletionStatus !== null &&
      !statusCredentialCorrupt;
    const state: ContributionRuntimeStatus["state"] = deletionStatusOperational
      ? credentials.deletionStatus.status === "complete"
        ? "deletion-complete"
        : credentials.deletionStatus.status === "failed"
          ? "deletion-failed"
          : "deletion-pending"
      : contributionOperational
        ? credentials.upload !== null && credentials.deletion !== null
          ? !uploadBlockedUntilRestart &&
            credentials.upload.lifecycle === "active"
            ? "active"
            : "stopped"
          : credentials.deletion !== null
            ? "stopped"
            : "off"
        : deletionOperational
          ? "stopped"
          : "unavailable";
    return Object.freeze({
      configured: baseUrl !== null,
      secureStorage: storageReady ? "os-backed" : "unavailable",
      state,
      enabled: contributionOperational && state === "active",
      canEnable:
        contributionOperational &&
        (state === "off" ||
          (state === "deletion-complete" &&
            credentials.rawUpload === null &&
            credentials.rawDeletion === null &&
            !localCleanupRequired &&
            outboxPending === 0 &&
            !localSyncState.mirrorPending) ||
          (state === "stopped" &&
            credentials.upload !== null &&
            !uploadBlockedUntilRestart)),
      canDelete: deletionOperational,
      canRecover:
        (baseOperational &&
          credentials.pendingEnrollment !== null &&
          !pendingActiveMismatch) ||
        (deletionStatusOperational &&
          (credentials.deletionStatus?.status === "queued" ||
            credentials.deletionStatus?.status === "running" ||
            credentials.rawUpload !== null ||
            credentials.rawDeletion !== null ||
            (credentials.deletionStatus?.status === "complete" &&
              (localCleanupRequired ||
                outboxPending > 0 ||
                localSyncState.mirrorPending)))),
      outboxPending,
      consentDocumentRevision:
        credentials.upload?.consentDocumentRevision ?? null,
      deletion:
        credentials.deletionStatus === null
          ? null
          : Object.freeze({
              jobId: credentials.deletionStatus.jobId,
              status: credentials.deletionStatus.status,
              requestedAt: credentials.deletionStatus.requestedAt,
              finishedAt: credentials.deletionStatus.finishedAt,
              anonymousHistoricalTotalsRetained: true as const,
            }),
    });
  };

  const requestJson = async (
    path: string,
    init: RequestInit,
    expectedStatuses: readonly number[],
    abortOnStop = true,
    recoverableEnrollment = false,
    ingestConsentRequiredIsStale = false,
  ): Promise<Readonly<{ status: number; body: unknown }>> => {
    if (baseUrl === null) {
      throw new ContributionServiceError("api-not-configured");
    }
    const controller = new AbortController();
    const requestState = Object.freeze({ controller, abortOnStop });
    activeRequest = requestState;
    const timer = setTimeout(
      () => controller.abort("timeout"),
      REQUEST_TIMEOUT_MS,
    );
    try {
      const response = await fetcher(`${baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      if (!expectedStatuses.includes(response.status)) {
        if (
          ingestConsentRequiredIsStale &&
          response.status === 403 &&
          PROBLEM_JSON_CONTENT_TYPE_PATTERN.test(
            response.headers.get("Content-Type")?.toLowerCase() ?? "",
          )
        ) {
          const problem = await readBoundedJson(response, true);
          if (isConsentRequiredProblem(problem)) {
            throw new ContributionServiceError("consent-stale");
          }
          throw new ContributionServiceError("request-rejected");
        }
        if (
          recoverableEnrollment &&
          (response.status === 400 || response.status === 403)
        ) {
          try {
            const problem = strictRecord(await readBoundedJson(response, true));
            if (
              problem !== null &&
              ((response.status === 403 &&
                problem["code"] === "CONSENT_REQUIRED") ||
                (response.status === 400 &&
                  (problem["code"] === "ACKNOWLEDGEMENT_IN_FUTURE" ||
                    problem["code"] === "ACKNOWLEDGEMENT_EXPIRED")))
            ) {
              throw new ContributionServiceError("consent-stale");
            }
          } catch (error: unknown) {
            if (error instanceof ContributionServiceError) throw error;
          }
        }
        if (response.status === 429) {
          throw new ContributionServiceError("rate-limited");
        }
        if (response.status >= 500) {
          throw new ContributionServiceError("server-unavailable");
        }
        throw new ContributionServiceError("request-rejected");
      }
      return Object.freeze({
        status: response.status,
        body: await readBoundedJson(response),
      });
    } catch (error: unknown) {
      if (error instanceof ContributionServiceError) throw error;
      if (controller.signal.aborted) {
        throw new ContributionServiceError("timeout");
      }
      throw new ContributionServiceError("network-error");
    } finally {
      clearTimeout(timer);
      if (activeRequest === requestState) activeRequest = null;
    }
  };

  const fetchConsent = async (): Promise<VerifiedConsentDocument> => {
    const response = await requestJson(
      "/v1/consent-documents/current?purpose=contribution&locale=zh-TW",
      { method: "GET", headers: { Accept: "application/json" } },
      [200],
    );
    return parseConsentDocument(response.body);
  };

  const pauseRemote = async (uploadToken: string): Promise<void> => {
    const response = await requestJson(
      "/v1/me/pause",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${uploadToken}`,
        },
      },
      [200],
      false,
    );
    if (!PauseResponseV1Schema.safeParse(response.body).success) {
      throw new ContributionServiceError("contract-mismatch");
    }
  };

  const transitionToConsentStale = async (
    upload: StoredUploadCredential,
  ): Promise<void> => {
    let durablyBlocked = false;
    try {
      await setCredential(
        options.uploadCredential,
        serializeUploadCredential({
          ...upload,
          lifecycle: "pause-pending",
        }),
      );
      durablyBlocked = true;
    } catch {
      try {
        await clearCredential(options.uploadCredential);
        durablyBlocked = true;
      } catch {
        // Keep this process fail-closed even when the credential host cannot
        // durably replace or remove the stale upload authority.
        uploadBlockedUntilRestart = true;
      }
    }
    if (durablyBlocked) uploadBlockedUntilRestart = false;
    try {
      options.store.clearCloudOutbox();
    } catch {
      // A durable stop marker, removed authority, or the process-local latch
      // prevents residual rows from being uploaded under stale consent.
    }
    await pauseRemote(upload.token).catch(() => undefined);
  };

  const activatePendingEnrollment = async (
    pending: StoredPendingEnrollment,
    prepared: PendingPreview | null,
  ): Promise<void> => {
    try {
      await setCredential(
        options.uploadCredential,
        serializeUploadCredential({
          token: pending.uploadToken,
          consentDocumentRevision: pending.consent.documentRevision,
          lifecycle: "active",
        }),
      );
      await setCredential(
        options.deletionCredential,
        serializeDeletionCredential({
          token: pending.deletionToken,
          idempotencyKey: pending.deletionIdempotencyKey,
        }),
      );
      await clearCredential(options.statusCredential);
      if (prepared !== null) enqueuePreparedSnapshot(prepared);
      // The only local copy of r2 lives in the complete pending bundle. It is
      // cleared last, after both active authorities are durably persisted.
      await clearCredential(options.pendingEnrollmentCredential);
    } catch {
      throw new ContributionServiceError("secure-storage-failed");
    }
  };

  const requestPendingEnrollment = async (
    pending: StoredPendingEnrollment,
  ): Promise<void> => {
    const enrolled = await requestJson(
      "/v2/enrollments",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify({
          contractVersion: 2,
          credentials: {
            uploadToken: pending.uploadToken,
            deletionToken: pending.deletionToken,
            recoveryToken: pending.recoveryToken,
          },
          consent: pending.consent,
        }),
      },
      [201],
      false,
      true,
    );
    const parsed = EnrollmentResponseV2Schema.safeParse(enrolled.body);
    if (
      !parsed.success ||
      parsed.data.status !== "active" ||
      parsed.data.consentReceipt.documentRevision !==
        pending.consent.documentRevision ||
      parsed.data.consentReceipt.acknowledgedAt !==
        pending.consent.acknowledgedAt ||
      parsed.data.consentReceipt.granted !== true
    ) {
      throw new ContributionServiceError("contract-mismatch");
    }
  };

  const reconcilePendingEnrollment = async (
    prepared: PendingPreview | null,
  ): Promise<"activated" | "consent-rejected" | "none"> => {
    const credentials = credentialState();
    if (credentials.rawPending === null) return "none";
    const pending = credentials.pendingEnrollment;
    if (pending === null) {
      throw new ContributionServiceError("local-service-error");
    }
    if (
      pendingMatchesActive(pending, credentials.upload, credentials.deletion)
    ) {
      try {
        await clearCredential(options.statusCredential);
        await clearCredential(options.pendingEnrollmentCredential);
        return "activated";
      } catch {
        throw new ContributionServiceError("secure-storage-failed");
      }
    }
    const partialUploadMatches =
      credentials.upload?.token === pending.uploadToken &&
      credentials.rawDeletion === null;
    const partialDeletionMatches =
      credentials.deletion?.token === pending.deletionToken &&
      credentials.rawUpload === null;
    if (
      (credentials.rawUpload !== null || credentials.rawDeletion !== null) &&
      !partialUploadMatches &&
      !partialDeletionMatches
    ) {
      throw new ContributionServiceError("local-service-error");
    }
    try {
      await requestPendingEnrollment(pending);
    } catch (error: unknown) {
      if (
        error instanceof ContributionServiceError &&
        error.code === "consent-stale"
      ) {
        try {
          await clearCredential(options.pendingEnrollmentCredential);
        } catch {
          throw new ContributionServiceError("secure-storage-failed");
        }
        return "consent-rejected";
      }
      throw error;
    }
    await activatePendingEnrollment(pending, prepared);
    return "activated";
  };

  const enqueuePreparedSnapshot = (prepared: PendingPreview): void => {
    if (prepared.snapshot === null) return;
    try {
      const expiresAt = snapshotExpiresAt(prepared.snapshot);
      options.store.enqueueCloudSnapshot(prepared.snapshot, {
        nextAttemptAt: prepared.snapshot.generatedAt,
        expiresAt,
      });
    } catch {
      options.store.clearCloudOutbox();
      throw new ContributionServiceError("local-service-error");
    }
  };

  const initialize = async (): Promise<void> => {
    if (initialized || disposed) return;
    const settled = await Promise.allSettled([
      initializeCredential(options.uploadCredential),
      initializeCredential(options.deletionCredential),
      initializeCredential(options.statusCredential),
      initializeCredential(options.pendingEnrollmentCredential),
    ]);
    initialized = true;
    storageReady = settled.every(
      (result): result is PromiseFulfilledResult<SecretSlotStatus> =>
        result.status === "fulfilled" &&
        result.value.persistence === "os-backed",
    );
    if (!storageReady) {
      pendingPreview = null;
      try {
        options.store.clearCloudOutbox();
      } catch {
        // A failed cleanup never enables network contribution.
      }
      return;
    }
    const credentials = credentialState();
    if (
      credentials.rawUpload === null &&
      credentials.rawDeletion === null &&
      credentials.rawStatus === null &&
      credentials.rawPending === null
    ) {
      try {
        clearContributionSyncState(options.store);
      } catch {
        localStateReady = false;
      }
    }
    if (credentials.rawPending !== null) {
      try {
        await reconcilePendingEnrollment(null);
      } catch {
        // Durable credential shape and matching rules below determine whether
        // recovery is safe. A transient vault write must not poison the local
        // store-health flag or hide byte-identical recovery authority.
      }
    } else if (credentials.deletionStatus !== null) {
      try {
        if (credentials.deletionStatus.status === "complete") {
          localCleanupRequired = true;
          clearContributionSyncState(options.store);
          localCleanupRequired = false;
        }
        await clearDeletionSupersededAuthorities();
      } catch {
        // The status authority remains durable. canRecover stays true while
        // superseded authority or completed-deletion local sync state remains.
      }
    }
  };

  const preparePreview = async (): Promise<ContributionPreview> => {
    if (disposed) {
      throw new ContributionServiceError("local-service-error");
    }
    if (!initialized || !storageReady) {
      throw new ContributionServiceError("secure-storage-unavailable");
    }
    if (baseUrl === null) {
      throw new ContributionServiceError("api-not-configured");
    }
    const current = status();
    if (!current.canEnable) {
      throw new ContributionServiceError("state-conflict");
    }
    if (current.state === "stopped") {
      try {
        // Stop may have completed its durable authority transition while local
        // queue cleanup was unavailable. No old, unseen batch crosses a fresh
        // consent preview boundary.
        options.store.clearCloudOutbox();
      } catch {
        throw new ContributionServiceError("local-service-error");
      }
    }
    if (current.state === "deletion-complete") {
      try {
        localCleanupRequired = true;
        clearContributionSyncState(options.store);
        localCleanupRequired = false;
      } catch {
        throw new ContributionServiceError("local-service-error");
      }
    }
    if (busy) throw new ContributionServiceError("busy");
    busy = true;
    try {
      const now = canonicalNow(clock);
      const [document, built] = await Promise.all([
        fetchConsent(),
        Promise.resolve().then(() => buildSnapshot(options.store, now, uuid)),
      ]);
      const previewId = generatedUuid(uuid);
      const preview: ContributionPreview = Object.freeze({
        previewId,
        expiresAt: new Date(now.getTime() + PREVIEW_LIFETIME_MS).toISOString(),
        document: Object.freeze(document),
        fieldAllowlist: CONTRIBUTION_FIELD_ALLOWLIST,
        forbidden: Object.freeze([
          "prompt / response / message content",
          "source code / filename / project path",
          "API key / OAuth token / provider credential",
          "raw log / event / session / hourly bucket",
        ]),
        payload: built.snapshot,
        eligibleBucketCount: built.snapshot?.buckets.length ?? 0,
        remainingEligibleBucketCount: Math.max(
          0,
          built.totalEligibleBuckets - (built.snapshot?.buckets.length ?? 0),
        ),
      });
      pendingPreview = Object.freeze({
        createdAtMs: now.getTime(),
        preview,
        snapshot: built.snapshot,
      });
      return preview;
    } finally {
      busy = false;
    }
  };

  const enable = async (
    previewId: string,
  ): Promise<ContributionActionResult> => {
    if (disposed) {
      return Object.freeze({
        ok: false,
        code: "local-service-error",
        status: status(),
      });
    }
    if (busy)
      return Object.freeze({ ok: false, code: "busy", status: status() });
    busy = true;
    try {
      const now = canonicalNow(clock);
      const prepared = pendingPreview;
      const previewAgeMs =
        prepared === null
          ? Number.POSITIVE_INFINITY
          : now.getTime() - prepared.createdAtMs;
      if (
        prepared === null ||
        previewId !== prepared.preview.previewId ||
        previewAgeMs < 0 ||
        previewAgeMs >= PREVIEW_LIFETIME_MS
      ) {
        throw new ContributionServiceError("preview-expired");
      }
      if (!storageReady) {
        throw new ContributionServiceError("secure-storage-unavailable");
      }
      const current = status();
      if (!current.canEnable) {
        throw new ContributionServiceError("state-conflict");
      }
      if (current.state === "stopped") {
        const credentials = credentialState();
        if (
          credentials.upload === null ||
          credentials.deletion === null ||
          credentials.upload.lifecycle === "active"
        ) {
          throw new ContributionServiceError("state-conflict");
        }
        try {
          // A resume consent covers only the payload displayed by this fresh
          // preview. Never carry pre-stop queue entries across that boundary.
          options.store.clearCloudOutbox();
        } catch {
          throw new ContributionServiceError("local-service-error");
        }
        let resumableUpload = credentials.upload;
        if (
          resumableUpload.lifecycle === "pause-pending" ||
          resumableUpload.lifecycle === "resume-pending"
        ) {
          // Either marker means the remote side may disagree with local state.
          // Re-establish a confirmed paused baseline before another resume.
          await pauseRemote(resumableUpload.token);
          try {
            await setCredential(
              options.uploadCredential,
              serializeUploadCredential({
                ...resumableUpload,
                lifecycle: "paused",
              }),
            );
          } catch {
            throw new ContributionServiceError("secure-storage-failed");
          }
          resumableUpload = Object.freeze({
            ...resumableUpload,
            lifecycle: "paused" as const,
          });
        }
        try {
          await setCredential(
            options.uploadCredential,
            serializeUploadCredential({
              ...resumableUpload,
              lifecycle: "resume-pending",
            }),
          );
        } catch {
          throw new ContributionServiceError("secure-storage-failed");
        }
        const acknowledgedAt = now.toISOString();
        const resumed = await requestJson(
          "/v1/me/resume",
          {
            method: "POST",
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${resumableUpload.token}`,
              "Content-Type": "application/json; charset=UTF-8",
            },
            body: JSON.stringify({
              contractVersion: 1,
              consent: {
                purpose: "contribution",
                documentRevision: prepared.preview.document.revision,
                granted: true,
                acknowledgedAt,
              },
            }),
          },
          [200],
          false,
        );
        const parsedResume = ResumeResponseV1Schema.safeParse(resumed.body);
        if (
          !parsedResume.success ||
          parsedResume.data.consentReceipt.documentRevision !==
            prepared.preview.document.revision ||
          parsedResume.data.consentReceipt.granted !== true ||
          parsedResume.data.consentReceipt.acknowledgedAt !== acknowledgedAt
        ) {
          throw new ContributionServiceError("contract-mismatch");
        }
        enqueuePreparedSnapshot(prepared);
        try {
          await setCredential(
            options.uploadCredential,
            serializeUploadCredential({
              token: resumableUpload.token,
              consentDocumentRevision: prepared.preview.document.revision,
              lifecycle: "active",
            }),
          );
        } catch {
          throw new ContributionServiceError("secure-storage-failed");
        }
        pendingPreview = null;
        return Object.freeze({ ok: true, code: "resumed", status: status() });
      }
      const pendingBefore = credentialState();
      if (pendingBefore.rawPending !== null) {
        const reconciled = await reconcilePendingEnrollment(prepared);
        if (reconciled === "consent-rejected") {
          pendingPreview = null;
          throw new ContributionServiceError("consent-stale");
        }
        if (reconciled !== "activated") {
          throw new ContributionServiceError("local-service-error");
        }
        pendingPreview = null;
        return Object.freeze({ ok: true, code: "enabled", status: status() });
      }

      const pending = generatePendingEnrollment(
        Object.freeze({
          purpose: "contribution" as const,
          documentRevision: prepared.preview.document.revision,
          granted: true as const,
          acknowledgedAt: now.toISOString(),
        }),
        generatedUuid(uuid),
        credentialBytes,
      );
      try {
        // One encrypted write is the durable pre-request authority. There is
        // no sequence of separate pending secret writes to crash between.
        await setCredential(
          options.pendingEnrollmentCredential,
          serializePendingEnrollment(pending),
        );
      } catch {
        throw new ContributionServiceError("secure-storage-failed");
      }
      const reconciled = await reconcilePendingEnrollment(prepared);
      if (reconciled === "consent-rejected") {
        pendingPreview = null;
        throw new ContributionServiceError("consent-stale");
      }
      if (reconciled !== "activated") {
        throw new ContributionServiceError("local-service-error");
      }
      pendingPreview = null;
      return Object.freeze({ ok: true, code: "enabled", status: status() });
    } catch (error: unknown) {
      const code =
        error instanceof ContributionServiceError
          ? error.code
          : "local-service-error";
      return Object.freeze({ ok: false, code, status: status() });
    } finally {
      busy = false;
    }
  };

  const uploadOne = async (
    snapshotInput: SupportedIngestSnapshot,
    uploadToken: string,
  ): Promise<void> => {
    const parsedSnapshot =
      SupportedIngestSnapshotSchema.safeParse(snapshotInput);
    if (!parsedSnapshot.success) {
      throw new ContributionServiceError("contract-mismatch");
    }
    const snapshot = parsedSnapshot.data;
    const response = await requestJson(
      "/v1/me/ingest-snapshots",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${uploadToken}`,
          "Content-Type": "application/json; charset=UTF-8",
          "Idempotency-Key": snapshot.batchId,
        },
        body: JSON.stringify(snapshot),
      },
      [200, 202],
      true,
      false,
      true,
    );
    const parsedReceipt = IngestReceiptV1Schema.safeParse(response.body);
    if (!parsedReceipt.success) {
      throw new ContributionServiceError("contract-mismatch");
    }
    const receipt = parsedReceipt.data;
    if (receipt.batchId !== snapshot.batchId) {
      throw new ContributionServiceError("contract-mismatch");
    }
    try {
      options.store.recordAcceptedCloudSnapshot(snapshot, receipt);
      if (!options.store.markCloudSnapshotDelivered(snapshot.batchId)) {
        throw new Error("OUTBOX_DELIVERY_NOT_RECORDED");
      }
    } catch {
      throw new ContributionServiceError("local-service-error");
    }
  };

  const sync = async (): Promise<ContributionSyncResult> => {
    if (disposed) {
      return Object.freeze({
        ok: false,
        code: "local-service-error",
        uploadedBatches: 0,
        status: status(),
      });
    }
    if (busy) {
      return Object.freeze({
        ok: false,
        code: "busy",
        uploadedBatches: 0,
        status: status(),
      });
    }
    busy = true;
    let uploadedBatches = 0;
    try {
      if (!initialized || !storageReady) {
        throw new ContributionServiceError("secure-storage-unavailable");
      }
      if (baseUrl === null) {
        throw new ContributionServiceError("api-not-configured");
      }
      if (status().state !== "active") {
        throw new ContributionServiceError("not-enabled");
      }
      const credentials = credentialState();
      if (credentials.upload === null || credentials.deletion === null) {
        throw new ContributionServiceError("not-enabled");
      }
      const now = canonicalNow(clock);
      options.store.purgeExpiredCloudSnapshots(now.toISOString());
      let due = options.store.listDueCloudSnapshots({
        now: now.toISOString(),
        limit: 10,
      });
      if (due.length === 0 && status().outboxPending === 0) {
        const built = buildSnapshot(options.store, now, uuid);
        if (built.snapshot !== null) {
          options.store.enqueueCloudSnapshot(built.snapshot, {
            nextAttemptAt: built.snapshot.generatedAt,
            expiresAt: snapshotExpiresAt(built.snapshot),
          });
          due = options.store.listDueCloudSnapshots({
            now: now.toISOString(),
            limit: 10,
          });
        }
      }
      if (due.length === 0) {
        return Object.freeze({
          ok: true,
          code: "nothing-due",
          uploadedBatches: 0,
          status: status(),
        });
      }
      const document = await fetchConsent();
      if (document.revision !== credentials.upload.consentDocumentRevision) {
        await transitionToConsentStale(credentials.upload);
        throw new ContributionServiceError("consent-stale");
      }
      for (const queued of due) {
        try {
          await uploadOne(queued.snapshot, credentials.upload.token);
          uploadedBatches += 1;
        } catch (error: unknown) {
          const code =
            error instanceof ContributionServiceError
              ? error.code
              : "network-error";
          if (code === "consent-stale") {
            await transitionToConsentStale(credentials.upload);
            throw error;
          }
          const retryCode: RetryCode | null =
            code === "rate-limited"
              ? "rate-limited"
              : code === "server-unavailable"
                ? "server-unavailable"
                : code === "timeout"
                  ? "timeout"
                  : code === "network-error"
                    ? "network"
                    : null;
          if (retryCode === null) throw error;
          const nextAttemptAt = nextRetryAt(
            now,
            queued.attempts,
            queued.expiresAt,
          );
          if (nextAttemptAt === null) {
            options.store.purgeExpiredCloudSnapshots(queued.expiresAt);
          } else {
            options.store.rescheduleCloudSnapshot({
              batchId: queued.snapshot.batchId,
              nextAttemptAt,
              errorCode: retryCode,
            });
          }
          throw error;
        }
      }
      return Object.freeze({
        ok: true,
        code: uploadedBatches === 0 ? "nothing-due" : "uploaded",
        uploadedBatches,
        status: status(),
      });
    } catch (error: unknown) {
      const code =
        error instanceof ContributionServiceError
          ? error.code
          : "local-service-error";
      return Object.freeze({
        ok: false,
        code,
        uploadedBatches,
        status: status(),
      });
    } finally {
      busy = false;
    }
  };

  const stop = async (): Promise<ContributionActionResult> => {
    if (disposed) {
      return Object.freeze({
        ok: false,
        code: "local-service-error",
        status: status(),
      });
    }
    if (activeRequest?.abortOnStop === true) {
      activeRequest.controller.abort("stopped");
    }
    while (busy) {
      if (activeRequest?.abortOnStop === true) {
        activeRequest.controller.abort("stopped");
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if (disposed) {
      return Object.freeze({
        ok: false,
        code: "local-service-error",
        status: status(),
      });
    }
    busy = true;
    try {
      pendingPreview = null;
      if (!initialized || !storageReady) {
        throw new ContributionServiceError("secure-storage-unavailable");
      }
      const credentials = credentialState();
      if (
        credentials.upload?.lifecycle === "active" ||
        credentials.upload?.lifecycle === "resume-pending"
      ) {
        try {
          await setCredential(
            options.uploadCredential,
            serializeUploadCredential({
              ...credentials.upload,
              lifecycle: "pause-pending",
            }),
          );
        } catch {
          await clearCredential(options.uploadCredential).catch(
            () => undefined,
          );
          try {
            options.store.clearCloudOutbox();
          } catch {
            // Upload authority removal or the remote pause remains the privacy
            // boundary; local queue cleanup can be retried independently.
          }
          await pauseRemote(credentials.upload.token).catch(() => undefined);
          throw new ContributionServiceError("secure-storage-failed");
        }
      }
      try {
        options.store.clearCloudOutbox();
      } catch {
        // Continue to the remote pause. A durable pause-pending marker already
        // prevents local sync after restart.
      }
      const stoppedUpload = credentialState().upload;
      if (stoppedUpload === null || stoppedUpload.lifecycle === "paused") {
        return Object.freeze({ ok: true, code: "stopped", status: status() });
      }
      await pauseRemote(stoppedUpload.token);
      try {
        await setCredential(
          options.uploadCredential,
          serializeUploadCredential({
            ...stoppedUpload,
            lifecycle: "paused",
          }),
        );
      } catch {
        throw new ContributionServiceError("secure-storage-failed");
      }
      return Object.freeze({ ok: true, code: "stopped", status: status() });
    } catch (error: unknown) {
      const code =
        error instanceof ContributionServiceError
          ? error.code
          : "local-service-error";
      const locallyStopped =
        credentialState().upload?.lifecycle === "pause-pending";
      if (
        locallyStopped &&
        (code === "network-error" ||
          code === "timeout" ||
          code === "rate-limited" ||
          code === "server-unavailable")
      ) {
        return Object.freeze({
          ok: true,
          code: "pause-pending",
          status: status(),
        });
      }
      return Object.freeze({
        ok: false,
        code,
        status: status(),
      });
    } finally {
      busy = false;
    }
  };

  const requestDeletion = async (): Promise<ContributionDeletionResult> => {
    if (disposed) {
      return Object.freeze({
        ok: false,
        code: "local-service-error",
        status: status(),
      });
    }
    if (activeRequest?.abortOnStop === true) {
      activeRequest.controller.abort("deletion-requested");
    }
    while (busy) {
      if (activeRequest?.abortOnStop === true) {
        activeRequest.controller.abort("deletion-requested");
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if (disposed) {
      return Object.freeze({
        ok: false,
        code: "local-service-error",
        status: status(),
      });
    }
    busy = true;
    try {
      pendingPreview = null;
      if (!initialized || !storageReady) {
        throw new ContributionServiceError("secure-storage-unavailable");
      }
      if (baseUrl === null) {
        throw new ContributionServiceError("api-not-configured");
      }
      const credentials = credentialState();
      if (credentials.deletionStatus !== null || !status().canDelete) {
        throw new ContributionServiceError("state-conflict");
      }
      if (credentials.deletion === null) {
        throw new ContributionServiceError("deletion-credential-unavailable");
      }
      try {
        // The deletion token and its stable idempotency key remain available
        // for retry, but upload authority is removed before the first DELETE.
        // A lost response therefore cannot make this enrollment upload again.
        await clearCredential(options.uploadCredential);
      } catch {
        throw new ContributionServiceError("secure-storage-failed");
      }
      try {
        options.store.clearCloudOutbox();
      } catch {
        // Upload authority is already gone, so these rows cannot leave the
        // device. Do not strand the user's cloud deletion on local SQLite;
        // accepted deletion status keeps cleanup recoverable.
      }
      const response = await requestJson(
        "/v1/me/data",
        {
          method: "DELETE",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${credentials.deletion.token}`,
            "Idempotency-Key": credentials.deletion.idempotencyKey,
          },
        },
        [202],
        false,
      );
      const parsedAccepted = DeletionAcceptedResponseV1Schema.safeParse(
        response.body,
      );
      if (!parsedAccepted.success) {
        throw new ContributionServiceError("contract-mismatch");
      }
      const accepted = parsedAccepted.data;
      await setCredential(
        options.statusCredential,
        serializeStatusCredential({
          token: accepted.statusToken,
          jobId: accepted.jobId,
          status: accepted.status,
          requestedAt: accepted.requestedAt,
          finishedAt: null,
        }),
      );
      await clearDeletionSupersededAuthorities().catch(() => undefined);
      return Object.freeze({
        ok: true,
        code: "deletion-requested",
        status: status(),
      });
    } catch (error: unknown) {
      const code =
        error instanceof ContributionServiceError
          ? error.code
          : "local-service-error";
      return Object.freeze({ ok: false, code, status: status() });
    } finally {
      busy = false;
    }
  };

  const refreshDeletionStatusAuthority =
    async (): Promise<ContributionDeletionResult> => {
      const tracking = credentialState().deletionStatus;
      if (tracking === null) {
        throw new ContributionServiceError("deletion-status-unavailable");
      }
      const response = await requestJson(
        `/v1/deletions/${tracking.jobId}`,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${tracking.token}`,
          },
        },
        [200],
      );
      const parsedRemote = DeletionStatusResponseV1Schema.safeParse(
        response.body,
      );
      if (!parsedRemote.success) {
        throw new ContributionServiceError("contract-mismatch");
      }
      const remote = parsedRemote.data;
      if (
        remote.jobId !== tracking.jobId ||
        remote.requestedAt !== tracking.requestedAt
      ) {
        throw new ContributionServiceError("contract-mismatch");
      }
      if (remote.status === "complete") {
        localCleanupRequired = true;
        try {
          // Persisting the terminal status is the commit point: once it exists,
          // all local cloud-sync residue has already been removed durably.
          clearContributionSyncState(options.store);
        } catch {
          throw new ContributionServiceError("local-service-error");
        }
        localCleanupRequired = false;
      }
      await setCredential(
        options.statusCredential,
        serializeStatusCredential({
          token: tracking.token,
          jobId: remote.jobId,
          status: remote.status,
          requestedAt: remote.requestedAt,
          finishedAt: remote.finishedAt,
        }),
      );
      await clearDeletionSupersededAuthorities().catch(() => undefined);
      return Object.freeze({
        ok: true,
        code: "deletion-status-updated",
        status: status(),
      });
    };

  const refreshDeletionStatus =
    async (): Promise<ContributionDeletionResult> => {
      if (disposed) {
        return Object.freeze({
          ok: false,
          code: "local-service-error",
          status: status(),
        });
      }
      if (busy) {
        return Object.freeze({ ok: false, code: "busy", status: status() });
      }
      busy = true;
      try {
        if (!initialized || !storageReady) {
          throw new ContributionServiceError("secure-storage-unavailable");
        }
        if (baseUrl === null) {
          throw new ContributionServiceError("api-not-configured");
        }
        return await refreshDeletionStatusAuthority();
      } catch (error: unknown) {
        const code =
          error instanceof ContributionServiceError
            ? error.code
            : "local-service-error";
        return Object.freeze({ ok: false, code, status: status() });
      } finally {
        busy = false;
      }
    };

  const recover = async (): Promise<ContributionActionResult> => {
    if (disposed) {
      return Object.freeze({
        ok: false,
        code: "local-service-error",
        status: status(),
      });
    }
    if (busy) {
      return Object.freeze({ ok: false, code: "busy", status: status() });
    }
    const before = credentialState();
    if (before.rawPending === null) {
      if (before.deletionStatus === null) {
        return Object.freeze({
          ok: false,
          code: "state-conflict",
          status: status(),
        });
      }
      if (busy) {
        return Object.freeze({ ok: false, code: "busy", status: status() });
      }
      busy = true;
      try {
        if (!initialized || !storageReady) {
          throw new ContributionServiceError("secure-storage-unavailable");
        }
        if (baseUrl === null) {
          throw new ContributionServiceError("api-not-configured");
        }
        if (
          before.deletionStatus.status === "queued" ||
          before.deletionStatus.status === "running"
        ) {
          return await refreshDeletionStatusAuthority();
        }
        if (before.deletionStatus.status === "complete") {
          localCleanupRequired = true;
          clearContributionSyncState(options.store);
          localCleanupRequired = false;
        }
        await clearDeletionSupersededAuthorities();
        return Object.freeze({
          ok: true,
          code: "deletion-status-updated",
          status: status(),
        });
      } catch (error: unknown) {
        const code =
          error instanceof ContributionServiceError
            ? error.code
            : "local-service-error";
        return Object.freeze({ ok: false, code, status: status() });
      } finally {
        busy = false;
      }
    }
    busy = true;
    try {
      if (!initialized || !storageReady) {
        throw new ContributionServiceError("secure-storage-unavailable");
      }
      if (baseUrl === null) {
        throw new ContributionServiceError("api-not-configured");
      }
      const reconciled = await reconcilePendingEnrollment(null);
      if (reconciled === "consent-rejected") {
        return Object.freeze({
          ok: false,
          code: "consent-stale",
          status: status(),
        });
      }
      if (reconciled !== "activated") {
        throw new ContributionServiceError("state-conflict");
      }
      const recoveredStatus = status();
      return Object.freeze({
        ok: true,
        code: recoveredStatus.enabled ? "enabled" : "stopped",
        status: recoveredStatus,
      });
    } catch (error: unknown) {
      const code =
        error instanceof ContributionServiceError
          ? error.code
          : "local-service-error";
      return Object.freeze({ ok: false, code, status: status() });
    } finally {
      busy = false;
    }
  };

  return Object.freeze({
    initialize,
    dispose(): void {
      disposed = true;
      pendingPreview = null;
      activeRequest?.controller.abort("disposed");
    },
    async quiesce(): Promise<void> {
      disposed = true;
      pendingPreview = null;
      activeRequest?.controller.abort("disposed");
      while (busy) {
        activeRequest?.controller.abort("disposed");
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    },
    status,
    preparePreview,
    enable,
    sync,
    stop,
    requestDeletion,
    refreshDeletionStatus,
    recover,
  });
}

export type { ContributionServiceOptions, ContributionStorePort };
