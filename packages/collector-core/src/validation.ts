import {
  CollectorIdentityV1Schema,
  DailyAggregateBucketV1Schema,
  type CollectorIdentityV1,
  type DailyAggregateBucketV1
} from "@tokenmonster/contracts";
import {
  parseCollectionUtcDate,
  parseTier1Client
} from "@tokenmonster/collector-tokscale";
import type {
  ProjectedDailyAggregate,
  StoredDailyAggregate
} from "@tokenmonster/local-store";

import { collectorCoreFailure } from "./errors.js";
import type {
  CompleteDailyCollectorScan,
  ContributionState,
  DailyCollectorScanOutcome,
  DueUploadQuery,
  ExplicitDailyScanRequest,
  UploadRetryInput
} from "./types.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIMESTAMP_PATTERN =
  /^20[2-9]\d-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;
const CONSENT_REVISION_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;
const OUTBOX_ERROR_CODES = new Set([
  "network",
  "timeout",
  "rate-limited",
  "server-unavailable",
  "clock-skew"
]);

type PlainRecord = Record<string, unknown>;

function strictDataRecord(
  input: unknown,
  expectedKeys: readonly string[]
): PlainRecord | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  let prototype: object | null;
  let ownKeys: readonly PropertyKey[];
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(input) as object | null;
    ownKeys = Reflect.ownKeys(input);
    descriptors = Object.getOwnPropertyDescriptors(input);
  } catch {
    return null;
  }
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (
    ownKeys.length !== expectedKeys.length ||
    ownKeys.some(
      (key) => typeof key !== "string" || !expectedKeys.includes(key)
    )
  ) {
    return null;
  }
  if (
    expectedKeys.some((key) => {
      const descriptor = descriptors[key];
      return descriptor === undefined || !("value" in descriptor);
    })
  ) {
    return null;
  }
  return input as PlainRecord;
}

function canonicalTimestamp(input: unknown): string | null {
  if (typeof input !== "string" || !TIMESTAMP_PATTERN.test(input)) return null;
  const milliseconds = Date.parse(input);
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === input
    ? input
    : null;
}

export function parseExplicitDailyScanRequest(
  input: unknown,
  now: Date
): ExplicitDailyScanRequest {
  const record = strictDataRecord(input, ["client", "utcDate"]);
  if (record === null) return collectorCoreFailure("SCAN_REQUEST_INVALID");
  try {
    return Object.freeze({
      client: parseTier1Client(record["client"]),
      utcDate: parseCollectionUtcDate(record["utcDate"], now)
    });
  } catch {
    return collectorCoreFailure("SCAN_REQUEST_INVALID");
  }
}

export function parseExactCollectorIdentity(
  input: unknown,
  expected: CollectorIdentityV1
): CollectorIdentityV1 {
  try {
    const parsed = CollectorIdentityV1Schema.safeParse(input);
    if (
      !parsed.success ||
      parsed.data.kind !== expected.kind ||
      parsed.data.adapterVersion !== expected.adapterVersion ||
      parsed.data.sourceVersion !== expected.sourceVersion
    ) {
      return collectorCoreFailure("COLLECTOR_IDENTITY_MISMATCH");
    }
    return Object.freeze({ ...parsed.data });
  } catch {
    return collectorCoreFailure("COLLECTOR_IDENTITY_MISMATCH");
  }
}

export function parseCollectorScanOutcome(
  input: unknown
): DailyCollectorScanOutcome {
  let status: unknown;
  try {
    if (typeof input !== "object" || input === null) {
      return collectorCoreFailure("COLLECTOR_OUTPUT_INVALID");
    }
    status = (input as Record<string, unknown>)["status"];
  } catch {
    return collectorCoreFailure("COLLECTOR_OUTPUT_INVALID");
  }
  if (status === "incomplete") {
    if (strictDataRecord(input, ["status"]) === null) {
      return collectorCoreFailure("COLLECTOR_OUTPUT_INVALID");
    }
    return Object.freeze({ status: "incomplete" });
  }
  if (status !== "complete") {
    return collectorCoreFailure("COLLECTOR_OUTPUT_INVALID");
  }
  const record = strictDataRecord(input, ["status", "snapshot"]);
  if (record === null) {
    return collectorCoreFailure("COLLECTOR_OUTPUT_INVALID");
  }
  const snapshot = record["snapshot"];
  if (snapshot === null) {
    return Object.freeze({ status: "complete", snapshot: null });
  }
  return Object.freeze({
    status: "complete",
    snapshot
  }) as unknown as CompleteDailyCollectorScan;
}

export function parseContributionState(input: unknown): ContributionState | null {
  let status: unknown;
  try {
    if (typeof input !== "object" || input === null) return null;
    status = (input as Record<string, unknown>)["status"];
  } catch {
    return null;
  }
  if (status === "disabled" || status === "paused") {
    return strictDataRecord(input, ["status"]) === null
      ? null
      : Object.freeze({ status });
  }
  if (status !== "active") return null;
  const record = strictDataRecord(input, [
    "status",
    "consentDocumentRevision",
    "currentDocumentRevision"
  ]);
  if (record === null) return null;
  const consent = record["consentDocumentRevision"];
  const current = record["currentDocumentRevision"];
  if (
    typeof consent !== "string" ||
    typeof current !== "string" ||
    !CONSENT_REVISION_PATTERN.test(consent) ||
    !CONSENT_REVISION_PATTERN.test(current)
  ) {
    return null;
  }
  return Object.freeze({
    status: "active",
    consentDocumentRevision: consent,
    currentDocumentRevision: current
  });
}

export function projectedRowToBucket(
  row: ProjectedDailyAggregate,
  revision: number
): DailyAggregateBucketV1 {
  try {
    return DailyAggregateBucketV1Schema.parse({
      bucketStart: row.bucketStart,
      provider: row.provider,
      modelFamily: row.modelFamily,
      tool: row.tool,
      valueQuality: row.valueQuality,
      revision,
      tokens: row.tokens
    });
  } catch {
    return collectorCoreFailure("LOCAL_APPLY_FAILED");
  }
}

export function storedRowToBucket(
  row: StoredDailyAggregate
): DailyAggregateBucketV1 {
  return projectedRowToBucket(row, row.revision);
}

export function parseUuid(input: unknown): string | null {
  return typeof input === "string" && UUID_PATTERN.test(input) ? input : null;
}

export function parseDueUploadQuery(input: unknown): DueUploadQuery {
  const record = strictDataRecord(input, ["now", "limit"]);
  if (record === null) return collectorCoreFailure("OUTBOX_READ_FAILED");
  const now = canonicalTimestamp(record["now"]);
  const limit = record["limit"];
  if (
    now === null ||
    !Number.isInteger(limit) ||
    (limit as number) < 1 ||
    (limit as number) > 30
  ) {
    return collectorCoreFailure("OUTBOX_READ_FAILED");
  }
  return Object.freeze({ now, limit: limit as number });
}

export function parseUploadRetryInput(input: unknown): UploadRetryInput {
  const record = strictDataRecord(input, [
    "batchId",
    "nextAttemptAt",
    "errorCode"
  ]);
  if (record === null) return collectorCoreFailure("OUTBOX_RETRY_FAILED");
  const batchId = parseUuid(record["batchId"]);
  const nextAttemptAt = canonicalTimestamp(record["nextAttemptAt"]);
  const errorCode = record["errorCode"];
  if (
    batchId === null ||
    nextAttemptAt === null ||
    typeof errorCode !== "string" ||
    !OUTBOX_ERROR_CODES.has(errorCode)
  ) {
    return collectorCoreFailure("OUTBOX_RETRY_FAILED");
  }
  return Object.freeze({
    batchId,
    nextAttemptAt,
    errorCode: errorCode as UploadRetryInput["errorCode"]
  });
}

export function sameCollectorIdentity(
  left: CollectorIdentityV1,
  right: CollectorIdentityV1
): boolean {
  return (
    left.kind === right.kind &&
    left.adapterVersion === right.adapterVersion &&
    left.sourceVersion === right.sourceVersion
  );
}

export function sameBucketProjection(
  bucket: DailyAggregateBucketV1,
  row: ProjectedDailyAggregate
): boolean {
  return (
    bucket.bucketStart === row.bucketStart &&
    bucket.provider === row.provider &&
    bucket.modelFamily === row.modelFamily &&
    bucket.tool === row.tool &&
    bucket.valueQuality === row.valueQuality &&
    bucket.tokens.input === row.tokens.input &&
    bucket.tokens.output === row.tokens.output &&
    bucket.tokens.cacheRead === row.tokens.cacheRead &&
    bucket.tokens.cacheWrite === row.tokens.cacheWrite &&
    bucket.tokens.reasoning === row.tokens.reasoning &&
    bucket.tokens.other === row.tokens.other &&
    bucket.tokens.total === row.tokens.total
  );
}
