import { randomUUID } from "node:crypto";

import {
  DeletionAcceptedResponseV1Schema,
  DeletionStatusResponseV1Schema,
  EnrollmentResponseV1Schema,
  IngestReceiptV1Schema,
  IngestSnapshotV1Schema,
  MAX_INGEST_BUCKETS_V1,
  type DailyAggregateBucketV1,
  type DeletionStatusResponseV1,
  type IngestSnapshotV1,
} from "@tokenmonster/contracts";
import type {
  EncryptedSecretSlot,
  SecretSlotStatus,
} from "@tokenmonster/secret-vault";
import type {
  LocalStore,
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
} from "../shared/ipc.js";

const DAY_MS = 86_400_000;
const MAX_RESPONSE_BYTES = 65_536;
const MAX_LOCAL_ROWS = 1_000;
const PREVIEW_LIFETIME_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const UPLOAD_TOKEN_PATTERN =
  /^tm_u1_[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{43}$/u;
const DELETION_TOKEN_PATTERN =
  /^tm_d1_[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{43}$/u;
const STATUS_TOKEN_PATTERN =
  /^tm_s1_[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{43}$/u;
const JOB_ID_PATTERN = /^del_[A-Za-z0-9_-]{22}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONSENT_REVISION_PATTERN =
  /^contribution-20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u;

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
  planMissingCloudZeroCorrections(input: Readonly<{
    bucketStart: string;
    completeScan: true;
    collector: StoredDailyAggregate["collector"];
    presentKeys: readonly Readonly<{
      provider: DailyAggregateBucketV1["provider"];
      modelFamily: string;
      tool: string;
    }>[];
    limit: number;
  }>): MissingCloudZeroCorrectionPlan;
  enqueueCloudSnapshot(
    snapshot: unknown,
    options: Readonly<{ nextAttemptAt: string; expiresAt: string }>,
  ): "inserted" | "idempotent";
  listDueCloudSnapshots(input: {
    readonly now: string;
    readonly limit: number;
  }): readonly Readonly<{
    snapshot: IngestSnapshotV1;
    attempts: number;
    expiresAt: string;
  }>[];
  rescheduleCloudSnapshot(input: Readonly<{
    batchId: string;
    nextAttemptAt: string;
    errorCode:
      | "network"
      | "timeout"
      | "rate-limited"
      | "server-unavailable"
      | "clock-skew";
  }>): boolean;
  recordAcceptedCloudSnapshot(snapshot: unknown, receipt: unknown): unknown;
  markCloudSnapshotDelivered(batchId: string): boolean;
  purgeExpiredCloudSnapshots(now: string): number;
  clearCloudOutbox(): number;
  clearCloudMirror(input: { readonly limit: number }): number;
  getDiagnosticSummary(): Readonly<{
    counts: Readonly<{ cloudOutboxEntries: number }>;
  }>;
}

interface ContributionServiceOptions {
  readonly store: ContributionStorePort;
  readonly uploadCredential: EncryptedSecretSlot;
  readonly deletionCredential: EncryptedSecretSlot;
  readonly statusCredential: EncryptedSecretSlot;
  readonly configuredBaseUrl: unknown;
  readonly allowedOrigins?: readonly string[];
  readonly fetcher?: FetchPort;
  readonly clock?: () => Date;
  readonly uuid?: () => string;
}

interface StoredUploadCredential {
  readonly token: string;
  readonly consentDocumentRevision: string;
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

interface VerifiedConsentDocument {
  readonly revision: string;
  readonly title: string;
  readonly summary: string;
  readonly retentionDisclosure: string;
}

interface PendingPreview {
  readonly createdAtMs: number;
  readonly preview: ContributionPreview;
  readonly snapshot: IngestSnapshotV1 | null;
}

type RetryCode =
  | "network"
  | "timeout"
  | "rate-limited"
  | "server-unavailable"
  | "clock-skew";

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
    keys.every(
      (key) => typeof key === "string" && expected.includes(key),
    )
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
    schemaVersion: 1,
    kind: "upload",
    token: input.token,
    consentDocumentRevision: input.consentDocumentRevision,
  });
}

function parseUploadCredential(input: string | null): StoredUploadCredential | null {
  if (input === null) return null;
  try {
    const record = strictRecord(JSON.parse(input) as unknown);
    if (
      record === null ||
      !exactKeys(record, [
        "schemaVersion",
        "kind",
        "token",
        "consentDocumentRevision",
      ]) ||
      record["schemaVersion"] !== 1 ||
      record["kind"] !== "upload" ||
      typeof record["token"] !== "string" ||
      !UPLOAD_TOKEN_PATTERN.test(record["token"]) ||
      typeof record["consentDocumentRevision"] !== "string" ||
      !CONSENT_REVISION_PATTERN.test(record["consentDocumentRevision"])
    ) {
      return null;
    }
    return Object.freeze({
      token: record["token"],
      consentDocumentRevision: record["consentDocumentRevision"],
    });
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

function parseStatusCredential(input: string | null): StoredStatusCredential | null {
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
    typeof record["title"] !== "string" ||
    record["title"].length < 1 ||
    record["title"].length > 200 ||
    typeof record["summary"] !== "string" ||
    record["summary"].length < 1 ||
    record["summary"].length > 2_000 ||
    !Array.isArray(allowlist) ||
    allowlist.length !== CONTRIBUTION_FIELD_ALLOWLIST.length ||
    allowlist.some(
      (field, index) => field !== CONTRIBUTION_FIELD_ALLOWLIST[index],
    ) ||
    retention === null ||
    retention["identifiableCurrentBucketsMaximumDays"] !== 30 ||
    typeof retention["disclosure"] !== "string" ||
    retention["disclosure"].length < 1 ||
    retention["disclosure"].length > 4_000 ||
    controls === null ||
    controls["defaultEnabled"] !== false ||
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

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/u.test(contentType)) {
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
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
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

function bucketKey(bucket: Pick<DailyAggregateBucketV1, "bucketStart" | "provider" | "modelFamily" | "tool">): string {
  return [bucket.bucketStart, bucket.provider, bucket.modelFamily, bucket.tool].join("|");
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
  const fromInclusive = new Date(Date.parse(toExclusive) - 29 * DAY_MS).toISOString();
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
  const allDayStarts = new Set([
    ...rawRowsByDay.keys(),
    ...mirrorRows.map((row) => row.bucket.bucketStart),
  ]);
  const eligibleDayStarts = new Set(
    [...allDayStarts].filter((bucketStart) => {
      const dayRows = rawRowsByDay.get(bucketStart) ?? [];
      return (
        store.getCompleteDailyScanCoverage({
          utcDate: bucketStart.slice(0, 10),
        }).complete && dayRows.every((row) => row.localCoverage === "complete")
      );
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
  const mirrors = new Map(mirrorRows.map((row) => [bucketKey(row.bucket), row]));
  const candidates = new Map<string, DailyAggregateBucketV1>();
  for (const row of eligible) {
    const mirror = mirrors.get(bucketKey(row));
    if (mirror !== undefined && sameWireValue(row, mirror)) continue;
    if (mirror !== undefined && !sameCollector(row.collector, mirror.collector)) {
      throw new ContributionServiceError("authority-conflict");
    }
    const revision =
      mirror === undefined
        ? row.revision
        : Math.max(row.revision, mirror.bucket.revision + 1);
    const bucket = IngestSnapshotV1Schema.shape.buckets.element.parse({
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
  const mirrorsByDay = new Map<string, StoredCloudMirrorRow[]>();
  for (const mirror of mirrorRows) {
    const rowsForDay = mirrorsByDay.get(mirror.bucket.bucketStart) ?? [];
    rowsForDay.push(mirror);
    mirrorsByDay.set(mirror.bucket.bucketStart, rowsForDay);
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
      limit: MAX_INGEST_BUCKETS_V1,
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
      if (current === undefined || current.revision < correction.bucket.revision) {
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

function snapshotExpiresAt(snapshot: IngestSnapshotV1): string {
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
): Readonly<{ snapshot: IngestSnapshotV1 | null; totalEligibleBuckets: number }> {
  const buckets = eligibleBuckets(store, now);
  if (buckets.length === 0) {
    return Object.freeze({ snapshot: null, totalEligibleBuckets: 0 });
  }
  const selected = buckets.slice(0, MAX_INGEST_BUCKETS_V1);
  const firstRow = store.listDailyAggregates({
    fromInclusive: selected[0]!.bucketStart,
    toExclusive: new Date(Date.parse(selected[0]!.bucketStart) + DAY_MS).toISOString(),
    limit: MAX_LOCAL_ROWS,
  }).find((row) => bucketKey(row) === bucketKey(selected[0]!));
  const firstMirror =
    firstRow === undefined
      ? store
          .listCloudMirror({
            fromInclusive: selected[0]!.bucketStart,
            toExclusive: new Date(
              Date.parse(selected[0]!.bucketStart) + DAY_MS,
            ).toISOString(),
            limit: MAX_LOCAL_ROWS,
          })
          .find((row) => bucketKey(row.bucket) === bucketKey(selected[0]!))
      : undefined;
  const collector = firstRow?.collector ?? firstMirror?.collector;
  if (collector === undefined) {
    throw new ContributionServiceError("local-service-error");
  }
  const snapshot = IngestSnapshotV1Schema.parse({
    schemaVersion: "1",
    batchId: generatedUuid(uuid),
    generatedAt: now.toISOString(),
    collector,
    buckets: selected,
  });
  if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > MAX_RESPONSE_BYTES) {
    throw new ContributionServiceError("local-data-too-large");
  }
  return Object.freeze({ snapshot, totalEligibleBuckets: buckets.length });
}

function nextRetryAt(now: Date, attempts: number, expiresAt: string): string | null {
  const delayMs = Math.min(6 * 60 * 60_000, 60_000 * 2 ** Math.min(attempts, 8));
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
  status(): ContributionRuntimeStatus;
  preparePreview(): Promise<ContributionPreview>;
  enable(previewId: string): Promise<ContributionActionResult>;
  sync(): Promise<ContributionSyncResult>;
  stop(): Promise<ContributionActionResult>;
  requestDeletion(): Promise<ContributionDeletionResult>;
  refreshDeletionStatus(): Promise<ContributionDeletionResult>;
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
  let initialized = false;
  let storageReady = false;
  let localStateReady = true;
  let pendingPreview: PendingPreview | null = null;
  let activeRequest: Readonly<{
    controller: AbortController;
    abortOnStop: boolean;
  }> | null = null;
  let busy = false;

  const credentialState = () => {
    const rawUpload = options.uploadCredential.get();
    const rawDeletion = options.deletionCredential.get();
    const rawStatus = options.statusCredential.get();
    return Object.freeze({
      rawUpload,
      rawDeletion,
      rawStatus,
      upload: parseUploadCredential(rawUpload),
      deletion: parseDeletionCredential(rawDeletion),
      deletionStatus: parseStatusCredential(rawStatus),
    });
  };

  const status = (): ContributionRuntimeStatus => {
    const credentials = credentialState();
    const corrupt =
      (credentials.rawUpload !== null && credentials.upload === null) ||
      (credentials.rawDeletion !== null && credentials.deletion === null) ||
      (credentials.rawStatus !== null && credentials.deletionStatus === null) ||
      (credentials.upload !== null &&
        credentials.deletion === null &&
        credentials.deletionStatus === null);
    const outboxPending = (() => {
      try {
        const value = options.store.getDiagnosticSummary().counts.cloudOutboxEntries;
        return Number.isSafeInteger(value) && value >= 0 ? value : 0;
      } catch {
        return 0;
      }
    })();
    const operational =
      initialized &&
      storageReady &&
      localStateReady &&
      baseUrl !== null &&
      !corrupt;
    const state: ContributionRuntimeStatus["state"] = !operational
      ? "unavailable"
      : credentials.deletionStatus !== null
        ? credentials.deletionStatus.status === "complete"
          ? "deletion-complete"
          : credentials.deletionStatus.status === "failed"
            ? "deletion-failed"
            : "deletion-pending"
        : credentials.upload !== null && credentials.deletion !== null
          ? "active"
          : credentials.deletion !== null
            ? "stopped"
            : "off";
    return Object.freeze({
      configured: baseUrl !== null,
      secureStorage: storageReady ? "os-backed" : "unavailable",
      state,
      enabled: operational && state === "active",
      canEnable:
        operational &&
        (state === "off" || state === "deletion-complete"),
      canDelete:
        operational &&
        credentials.deletion !== null &&
        credentials.deletionStatus === null,
      outboxPending,
      consentDocumentRevision: credentials.upload?.consentDocumentRevision ?? null,
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
  ): Promise<Readonly<{ status: number; body: unknown }>> => {
    if (baseUrl === null) {
      throw new ContributionServiceError("api-not-configured");
    }
    const controller = new AbortController();
    const requestState = Object.freeze({ controller, abortOnStop });
    activeRequest = requestState;
    const timer = setTimeout(() => controller.abort("timeout"), REQUEST_TIMEOUT_MS);
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
        if (response.status === 429) {
          throw new ContributionServiceError("rate-limited");
        }
        if (response.status >= 500) {
          throw new ContributionServiceError("server-unavailable");
        }
        throw new ContributionServiceError("request-rejected");
      }
      return Object.freeze({ status: response.status, body: await readBoundedJson(response) });
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

  const initialize = async (): Promise<void> => {
    if (initialized) return;
    const settled = await Promise.allSettled([
      options.uploadCredential.initialize(),
      options.deletionCredential.initialize(),
      options.statusCredential.initialize(),
    ]);
    initialized = true;
    storageReady = settled.every(
      (result): result is PromiseFulfilledResult<SecretSlotStatus> =>
        result.status === "fulfilled" && result.value.persistence === "os-backed",
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
      credentials.rawStatus === null
    ) {
      try {
        clearContributionSyncState(options.store);
      } catch {
        localStateReady = false;
      }
    }
  };

  const preparePreview = async (): Promise<ContributionPreview> => {
    if (!initialized || !storageReady) {
      throw new ContributionServiceError("secure-storage-unavailable");
    }
    if (baseUrl === null) {
      throw new ContributionServiceError("api-not-configured");
    }
    const current = status();
    if (current.state !== "off" && current.state !== "deletion-complete") {
      throw new ContributionServiceError("state-conflict");
    }
    if (current.state === "deletion-complete") {
      try {
        clearContributionSyncState(options.store);
      } catch {
        localStateReady = false;
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

  const enable = async (previewId: string): Promise<ContributionActionResult> => {
    if (busy) return Object.freeze({ ok: false, code: "busy", status: status() });
    busy = true;
    try {
      const now = canonicalNow(clock);
      const prepared = pendingPreview;
      const previewAgeMs =
        prepared === null ? Number.POSITIVE_INFINITY : now.getTime() - prepared.createdAtMs;
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
      if (current.state !== "off" && current.state !== "deletion-complete") {
        throw new ContributionServiceError("state-conflict");
      }
      const enrolled = await requestJson(
        "/v1/enrollments",
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json; charset=UTF-8",
          },
          body: JSON.stringify({
            contractVersion: 1,
            consent: {
              purpose: "contribution",
              documentRevision: prepared.preview.document.revision,
              granted: true,
              acknowledgedAt: now.toISOString(),
            },
          }),
        },
        [201],
        false,
      );
      const parsedEnrollment = EnrollmentResponseV1Schema.safeParse(enrolled.body);
      if (!parsedEnrollment.success) {
        throw new ContributionServiceError("contract-mismatch");
      }
      const response = parsedEnrollment.data;
      if (
        response.consentReceipt.documentRevision !== prepared.preview.document.revision ||
        response.consentReceipt.granted !== true
      ) {
        throw new ContributionServiceError("contract-mismatch");
      }
      const deletionIdempotencyKey = generatedUuid(uuid);
      try {
        await options.deletionCredential.set(
          serializeDeletionCredential({
            token: response.credentials.deletionToken,
            idempotencyKey: deletionIdempotencyKey,
          }),
        );
        await options.uploadCredential.set(
          serializeUploadCredential({
            token: response.credentials.uploadToken,
            consentDocumentRevision: prepared.preview.document.revision,
          }),
        );
        await options.statusCredential.clear();
      } catch {
        await options.uploadCredential.clear().catch(() => undefined);
        await options.deletionCredential.clear().catch(() => undefined);
        await options.statusCredential.clear().catch(() => undefined);
        try {
          await requestJson(
            "/v1/me/data",
            {
              method: "DELETE",
              headers: {
                Accept: "application/json",
                Authorization: `Bearer ${response.credentials.deletionToken}`,
                "Idempotency-Key": deletionIdempotencyKey,
              },
            },
            [202],
            false,
          );
        } catch {
          // The local result remains fail-closed. Operators must treat this
          // best-effort cleanup failure as a potential orphan enrollment.
        }
        throw new ContributionServiceError("secure-storage-failed");
      }
      if (prepared.snapshot !== null) {
        try {
          const expiresAt = snapshotExpiresAt(prepared.snapshot);
          options.store.enqueueCloudSnapshot(prepared.snapshot, {
            nextAttemptAt: prepared.snapshot.generatedAt,
            expiresAt,
          });
        } catch {
          options.store.clearCloudOutbox();
          await options.uploadCredential.clear();
          throw new ContributionServiceError("local-service-error");
        }
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
    snapshot: IngestSnapshotV1,
    uploadToken: string,
  ): Promise<void> => {
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
    if (busy) {
      return Object.freeze({ ok: false, code: "busy", uploadedBatches: 0, status: status() });
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
        throw new ContributionServiceError("consent-stale");
      }
      for (const queued of due) {
        try {
          await uploadOne(queued.snapshot, credentials.upload.token);
          uploadedBatches += 1;
        } catch (error: unknown) {
          const code =
            error instanceof ContributionServiceError ? error.code : "network-error";
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
          const nextAttemptAt = nextRetryAt(now, queued.attempts, queued.expiresAt);
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
      return Object.freeze({ ok: false, code, uploadedBatches, status: status() });
    } finally {
      busy = false;
    }
  };

  const stop = async (): Promise<ContributionActionResult> => {
    if (activeRequest?.abortOnStop === true) {
      activeRequest.controller.abort("stopped");
    }
    while (busy) {
      if (activeRequest?.abortOnStop === true) {
        activeRequest.controller.abort("stopped");
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    busy = true;
    try {
      pendingPreview = null;
      options.store.clearCloudOutbox();
      await options.uploadCredential.clear();
      return Object.freeze({ ok: true, code: "stopped", status: status() });
    } catch {
      return Object.freeze({
        ok: false,
        code: "secure-storage-failed",
        status: status(),
      });
    } finally {
      busy = false;
    }
  };

  const requestDeletion = async (): Promise<ContributionDeletionResult> => {
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
      const credentials = credentialState();
      if (
        credentials.deletionStatus !== null ||
        (status().state !== "active" && status().state !== "stopped")
      ) {
        throw new ContributionServiceError("state-conflict");
      }
      if (credentials.deletion === null) {
        throw new ContributionServiceError("deletion-credential-unavailable");
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
      await options.statusCredential.set(
        serializeStatusCredential({
          token: accepted.statusToken,
          jobId: accepted.jobId,
          status: accepted.status,
          requestedAt: accepted.requestedAt,
          finishedAt: null,
        }),
      );
      options.store.clearCloudOutbox();
      await options.uploadCredential.clear();
      await options.deletionCredential.clear();
      return Object.freeze({ ok: true, code: "deletion-requested", status: status() });
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

  const refreshDeletionStatus = async (): Promise<ContributionDeletionResult> => {
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
      await options.statusCredential.set(
        serializeStatusCredential({
          token: tracking.token,
          jobId: remote.jobId,
          status: remote.status,
          requestedAt: remote.requestedAt,
          finishedAt: remote.finishedAt,
        }),
      );
      if (remote.status === "complete") {
        try {
          clearContributionSyncState(options.store);
        } catch {
          localStateReady = false;
          throw new ContributionServiceError("local-service-error");
        }
      }
      return Object.freeze({ ok: true, code: "deletion-status-updated", status: status() });
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
      pendingPreview = null;
      if (activeRequest?.abortOnStop === true) {
        activeRequest.controller.abort("disposed");
      }
    },
    status,
    preparePreview,
    enable,
    sync,
    stop,
    requestDeletion,
    refreshDeletionStatus,
  });
}

export type { ContributionServiceOptions, ContributionStorePort };
