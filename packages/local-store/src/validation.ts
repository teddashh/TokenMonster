import {
  DailyAggregateBucketV1Schema,
  IngestReceiptV1Schema,
  SupportedCollectorIdentitySchema,
  SupportedIngestSnapshotSchema,
  type IngestReceiptV1,
  type SupportedIngestSnapshot,
} from "@tokenmonster/contracts";
import {
  MonsterCharacterIdV1Schema,
  MonsterStateV1Schema,
  type MonsterStateV1,
} from "@tokenmonster/monster-engine";

import { LocalStoreError, type LocalStoreErrorCode } from "./errors.js";
import {
  CLOUD_OUTBOX_ERROR_CODES,
  COLLECTOR_AUTHORITY_STATES,
  COMPLETE_SCAN_CLIENTS,
  LOCAL_USAGE_INSIGHT_WINDOWS,
  type CloudOutboxErrorCode,
  type CloudMirrorClearQuery,
  type CloudMirrorPresenceKey,
  type CloudMirrorQuery,
  type CollectorAuthorityInput,
  type CompleteDailyScanCoverageQuery,
  type CompleteDailyScanInput,
  type ContentBlindExportOptions,
  type DailyAggregateQuery,
  type DueCloudSnapshotQuery,
  type EnqueueCloudSnapshotOptions,
  type LocalCompanionConfigV1,
  type LocalUsageInsightsQuery,
  type MissingCloudZeroCorrectionQuery,
  type MonsterSnapshotInput,
  type OpenLocalStoreOptions,
  type ProjectedDailyAggregate,
  type RescheduleCloudSnapshotInput,
} from "./types.js";

const UTC_DAY_PATTERN =
  /^20[2-9]\d-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T00:00:00\.000Z$/;
const UTC_DATE_PATTERN =
  /^20[2-9]\d-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const ISO_TIMESTAMP_PATTERN =
  /^20[2-9]\d-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SAFE_REVISION = Number.MAX_SAFE_INTEGER;
const MAX_QUERY_ROWS = 1_000;
const MAX_EXPORT_ROWS = 5_000;
const MAX_OUTBOX_ROWS = 30;
const MAX_CLOUD_MIRROR_ROWS = 1_000;
const MAX_ZERO_CORRECTIONS = 30;
const MAX_DAILY_BATCH_ROWS = 1_000;
const THIRTY_DAYS_MS = 30 * 86_400_000;

type PlainRecord = Record<PropertyKey, unknown>;

function hasOwn(input: unknown, key: PropertyKey): boolean {
  return (typeof input === "object" && input !== null) ||
    typeof input === "function"
    ? Object.hasOwn(input, key)
    : false;
}

function fail(code: LocalStoreErrorCode, message: string): never {
  throw new LocalStoreError(code, message);
}

function asStrictRecord(
  input: unknown,
  keys: readonly string[],
  code: LocalStoreErrorCode,
  message: string,
): PlainRecord {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return fail(code, message);
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(code, message);
  }
  const ownKeys = Reflect.ownKeys(input);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    return fail(code, message);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    ownKeys.some(
      (key) =>
        typeof key !== "string" ||
        descriptors[key] === undefined ||
        !("value" in descriptors[key]),
    )
  ) {
    return fail(code, message);
  }
  return input as PlainRecord;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) {
    return false;
  }
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}

export function parseTimestamp(
  input: unknown,
  code: LocalStoreErrorCode,
  message: string,
): string {
  if (!isCanonicalTimestamp(input)) return fail(code, message);
  return input;
}

export function parseUtcDay(
  input: unknown,
  code: LocalStoreErrorCode,
  message: string,
): string {
  if (
    typeof input !== "string" ||
    !UTC_DAY_PATTERN.test(input) ||
    Number.isNaN(Date.parse(input)) ||
    new Date(Date.parse(input)).toISOString() !== input
  ) {
    return fail(code, message);
  }
  return input;
}

export function parseUtcDate(
  input: unknown,
  code: LocalStoreErrorCode,
  message: string,
): string {
  if (
    typeof input !== "string" ||
    !UTC_DATE_PATTERN.test(input) ||
    Number.isNaN(Date.parse(`${input}T00:00:00.000Z`)) ||
    new Date(Date.parse(`${input}T00:00:00.000Z`))
      .toISOString()
      .slice(0, 10) !== input
  ) {
    return fail(code, message);
  }
  return input;
}

export function parseCompleteDailyScanInput(
  input: unknown,
): CompleteDailyScanInput {
  const message = "Complete scan evidence did not match the local schema.";
  const record = asStrictRecord(
    input,
    ["utcDate", "client"],
    "INVALID_SCAN_LEDGER",
    message,
  );
  const client = record["client"];
  if (
    typeof client !== "string" ||
    !COMPLETE_SCAN_CLIENTS.some((candidate) => candidate === client)
  ) {
    return fail("INVALID_SCAN_LEDGER", message);
  }
  return Object.freeze({
    utcDate: parseUtcDate(record["utcDate"], "INVALID_SCAN_LEDGER", message),
    client: client as CompleteDailyScanInput["client"],
  });
}

export function parseCompleteDailyScanCoverageQuery(
  input: unknown,
): CompleteDailyScanCoverageQuery {
  const message = "Complete scan coverage query is invalid.";
  const record = asStrictRecord(input, ["utcDate"], "INVALID_QUERY", message);
  return Object.freeze({
    utcDate: parseUtcDate(record["utcDate"], "INVALID_QUERY", message),
  });
}

function parsePositiveSafeInteger(
  input: unknown,
  code: LocalStoreErrorCode,
  message: string,
): number {
  if (!Number.isSafeInteger(input) || (input as number) <= 0) {
    return fail(code, message);
  }
  return input as number;
}

export function parseProjectedDailyAggregate(
  input: unknown,
): ProjectedDailyAggregate {
  const record = asStrictRecord(
    input,
    [
      "bucketStart",
      "provider",
      "modelFamily",
      "tool",
      "valueQuality",
      "tokens",
      "localCoverage",
      "collector",
    ],
    "INVALID_DAILY_AGGREGATE",
    "Daily aggregate did not match the content-blind local schema.",
  );

  try {
    const bucket = DailyAggregateBucketV1Schema.parse({
      bucketStart: record["bucketStart"],
      provider: record["provider"],
      modelFamily: record["modelFamily"],
      tool: record["tool"],
      valueQuality: record["valueQuality"],
      revision: 1,
      tokens: record["tokens"],
    });
    const collector = SupportedCollectorIdentitySchema.parse(
      record["collector"],
    );
    const localCoverage = record["localCoverage"];
    if (
      localCoverage !== "complete" &&
      localCoverage !== "partial" &&
      localCoverage !== "unknown"
    ) {
      return fail(
        "INVALID_DAILY_AGGREGATE",
        "Daily aggregate did not match the content-blind local schema.",
      );
    }
    return Object.freeze({
      bucketStart: bucket.bucketStart,
      provider: bucket.provider,
      modelFamily: bucket.modelFamily,
      tool: bucket.tool,
      valueQuality: bucket.valueQuality,
      tokens: Object.freeze({ ...bucket.tokens }),
      localCoverage,
      collector: Object.freeze({ ...collector }),
    });
  } catch (error: unknown) {
    if (error instanceof LocalStoreError) throw error;
    return fail(
      "INVALID_DAILY_AGGREGATE",
      "Daily aggregate did not match the content-blind local schema.",
    );
  }
}

export function parseDailyAggregateBatch(
  input: readonly unknown[],
): readonly ProjectedDailyAggregate[] {
  if (!Array.isArray(input) || input.length > MAX_DAILY_BATCH_ROWS) {
    return fail(
      "BATCH_TOO_LARGE",
      "A local daily aggregate transaction may contain at most 1000 rows.",
    );
  }
  const parsed = input.map(parseProjectedDailyAggregate);
  const keys = new Set<string>();
  for (const row of parsed) {
    const key = [row.bucketStart, row.provider, row.modelFamily, row.tool].join(
      "|",
    );
    if (keys.has(key)) {
      return fail(
        "DUPLICATE_DAILY_KEY",
        "A local daily aggregate transaction cannot repeat a key.",
      );
    }
    keys.add(key);
  }
  return parsed;
}

export function parseLocalUsageInsightsQuery(
  input: unknown,
): LocalUsageInsightsQuery {
  const record = asStrictRecord(
    input,
    ["windowDays"],
    "INVALID_QUERY",
    "Local usage insights query is invalid.",
  );
  const windowDays = record["windowDays"];
  if (
    typeof windowDays !== "number" ||
    !LOCAL_USAGE_INSIGHT_WINDOWS.some(
      (candidate) => candidate === windowDays,
    )
  ) {
    return fail("INVALID_QUERY", "Local usage insights query is invalid.");
  }
  return Object.freeze({
    windowDays: windowDays as LocalUsageInsightsQuery["windowDays"],
  });
}

export function parseDailyAggregateQuery(input: unknown): DailyAggregateQuery {
  const record = asStrictRecord(
    input,
    ["fromInclusive", "toExclusive", "limit"].filter((key) =>
      hasOwn(input, key),
    ),
    "INVALID_QUERY",
    "Daily aggregate query is invalid.",
  );
  const limit = record["limit"];
  if (
    !Number.isInteger(limit) ||
    (limit as number) < 1 ||
    (limit as number) > MAX_QUERY_ROWS
  ) {
    return fail("INVALID_QUERY", "Daily aggregate query is invalid.");
  }
  const fromInclusive = Object.hasOwn(record, "fromInclusive")
    ? parseUtcDay(
        record["fromInclusive"],
        "INVALID_QUERY",
        "Daily aggregate query is invalid.",
      )
    : undefined;
  const toExclusive = Object.hasOwn(record, "toExclusive")
    ? parseUtcDay(
        record["toExclusive"],
        "INVALID_QUERY",
        "Daily aggregate query is invalid.",
      )
    : undefined;
  if (
    fromInclusive !== undefined &&
    toExclusive !== undefined &&
    fromInclusive >= toExclusive
  ) {
    return fail("INVALID_QUERY", "Daily aggregate query is invalid.");
  }
  return {
    ...(fromInclusive === undefined ? {} : { fromInclusive }),
    ...(toExclusive === undefined ? {} : { toExclusive }),
    limit: limit as number,
  };
}

export function parseCollectorAuthority(
  input: unknown,
): CollectorAuthorityInput {
  const record = asStrictRecord(
    input,
    ["kind", "adapterVersion", "sourceVersion", "state"],
    "INVALID_AUTHORITY",
    "Collector authority did not match the allowlisted schema.",
  );
  try {
    const collector = SupportedCollectorIdentitySchema.parse({
      kind: record["kind"],
      adapterVersion: record["adapterVersion"],
      sourceVersion: record["sourceVersion"],
    });
    const state = record["state"];
    if (
      typeof state !== "string" ||
      !COLLECTOR_AUTHORITY_STATES.includes(
        state as (typeof COLLECTOR_AUTHORITY_STATES)[number],
      )
    ) {
      return fail(
        "INVALID_AUTHORITY",
        "Collector authority did not match the allowlisted schema.",
      );
    }
    return Object.freeze({ ...collector, state }) as CollectorAuthorityInput;
  } catch {
    return fail(
      "INVALID_AUTHORITY",
      "Collector authority did not match the allowlisted schema.",
    );
  }
}

function isSupportedTimezone(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 64)
    return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function parseLocalConfig(input: unknown): LocalCompanionConfigV1 {
  const record = asStrictRecord(
    input,
    [
      "schemaVersion",
      "locale",
      "timezone",
      "selectedCharacterId",
      "collectionIntervalMinutes",
      "startAtLogin",
      "animationsEnabled",
    ],
    "INVALID_CONFIG",
    "Local configuration did not match the non-secret schema.",
  );
  const selectedCharacter = MonsterCharacterIdV1Schema.safeParse(
    record["selectedCharacterId"],
  );
  const interval = record["collectionIntervalMinutes"];
  if (
    record["schemaVersion"] !== "1" ||
    (record["locale"] !== "zh-TW" && record["locale"] !== "en") ||
    !isSupportedTimezone(record["timezone"]) ||
    !selectedCharacter.success ||
    (interval !== 15 && interval !== 30 && interval !== 60) ||
    typeof record["startAtLogin"] !== "boolean" ||
    typeof record["animationsEnabled"] !== "boolean"
  ) {
    return fail(
      "INVALID_CONFIG",
      "Local configuration did not match the non-secret schema.",
    );
  }
  return Object.freeze({
    schemaVersion: "1",
    locale: record["locale"],
    timezone: record["timezone"],
    selectedCharacterId: selectedCharacter.data,
    collectionIntervalMinutes: interval,
    startAtLogin: record["startAtLogin"],
    animationsEnabled: record["animationsEnabled"],
  });
}

export function parseMonsterSnapshot(input: unknown): MonsterSnapshotInput {
  const record = asStrictRecord(
    input,
    ["state", "asOfRevision"],
    "INVALID_MONSTER_SNAPSHOT",
    "Monster snapshot did not match the deterministic state schema.",
  );
  try {
    const state = MonsterStateV1Schema.parse(record["state"]);
    const asOfRevision = parsePositiveSafeInteger(
      record["asOfRevision"],
      "INVALID_MONSTER_SNAPSHOT",
      "Monster snapshot did not match the deterministic state schema.",
    );
    return Object.freeze({
      state: Object.freeze(state) as MonsterStateV1,
      asOfRevision,
    });
  } catch (error: unknown) {
    if (error instanceof LocalStoreError) throw error;
    return fail(
      "INVALID_MONSTER_SNAPSHOT",
      "Monster snapshot did not match the deterministic state schema.",
    );
  }
}

export function parseCloudSnapshot(input: unknown): SupportedIngestSnapshot {
  try {
    return SupportedIngestSnapshotSchema.parse(input);
  } catch {
    return fail(
      "INVALID_OUTBOX_ENTRY",
      "Cloud outbox payload did not match a supported ingest snapshot.",
    );
  }
}

export function parseAcceptedCloudSnapshot(
  snapshotInput: unknown,
  receiptInput: unknown,
): {
  readonly snapshot: SupportedIngestSnapshot;
  readonly receipt: IngestReceiptV1;
} {
  const snapshot = parseCloudSnapshot(snapshotInput);
  let receipt: IngestReceiptV1;
  try {
    receipt = IngestReceiptV1Schema.parse(receiptInput);
  } catch {
    return fail(
      "INVALID_CLOUD_MIRROR_RECEIPT",
      "Cloud mirror receipt did not match IngestReceiptV1.",
    );
  }
  if (
    receipt.batchId !== snapshot.batchId ||
    receipt.status !== "accepted" ||
    receipt.summary.staleBuckets !== 0 ||
    receipt.summary.quarantinedBuckets !== 0 ||
    receipt.summary.appliedBuckets + receipt.summary.idempotentBuckets !==
      snapshot.buckets.length
  ) {
    return fail(
      "INVALID_CLOUD_MIRROR_RECEIPT",
      "Cloud mirror requires a receipt proving every snapshot bucket is accepted.",
    );
  }
  return Object.freeze({ snapshot, receipt });
}

export function parseCloudMirrorQuery(input: unknown): CloudMirrorQuery {
  const keys = ["fromInclusive", "toExclusive", "limit"].filter((key) =>
    hasOwn(input, key),
  );
  const record = asStrictRecord(
    input,
    keys,
    "INVALID_QUERY",
    "Cloud mirror query is invalid.",
  );
  const limit = record["limit"];
  if (
    !Number.isInteger(limit) ||
    (limit as number) < 1 ||
    (limit as number) > MAX_CLOUD_MIRROR_ROWS
  ) {
    return fail("INVALID_QUERY", "Cloud mirror query is invalid.");
  }
  const fromInclusive = hasOwn(record, "fromInclusive")
    ? parseUtcDay(
        record["fromInclusive"],
        "INVALID_QUERY",
        "Cloud mirror query is invalid.",
      )
    : undefined;
  const toExclusive = hasOwn(record, "toExclusive")
    ? parseUtcDay(
        record["toExclusive"],
        "INVALID_QUERY",
        "Cloud mirror query is invalid.",
      )
    : undefined;
  if (
    fromInclusive !== undefined &&
    toExclusive !== undefined &&
    fromInclusive >= toExclusive
  ) {
    return fail("INVALID_QUERY", "Cloud mirror query is invalid.");
  }
  return Object.freeze({
    ...(fromInclusive === undefined ? {} : { fromInclusive }),
    ...(toExclusive === undefined ? {} : { toExclusive }),
    limit: limit as number,
  });
}

export function parseCloudMirrorClearQuery(
  input: unknown,
): CloudMirrorClearQuery {
  const keys = ["beforeExclusive", "limit"].filter((key) => hasOwn(input, key));
  const record = asStrictRecord(
    input,
    keys,
    "INVALID_QUERY",
    "Cloud mirror clear query is invalid.",
  );
  const limit = record["limit"];
  if (
    !Number.isInteger(limit) ||
    (limit as number) < 1 ||
    (limit as number) > MAX_CLOUD_MIRROR_ROWS
  ) {
    return fail("INVALID_QUERY", "Cloud mirror clear query is invalid.");
  }
  const beforeExclusive = hasOwn(record, "beforeExclusive")
    ? parseUtcDay(
        record["beforeExclusive"],
        "INVALID_QUERY",
        "Cloud mirror clear query is invalid.",
      )
    : undefined;
  return Object.freeze({
    ...(beforeExclusive === undefined ? {} : { beforeExclusive }),
    limit: limit as number,
  });
}

function parseCloudMirrorPresenceKey(input: unknown): CloudMirrorPresenceKey {
  const record = asStrictRecord(
    input,
    ["provider", "modelFamily", "tool"],
    "INVALID_CLOUD_MIRROR",
    "Cloud mirror presence key is invalid.",
  );
  try {
    const bucket = DailyAggregateBucketV1Schema.parse({
      bucketStart: "2020-01-01T00:00:00.000Z",
      provider: record["provider"],
      modelFamily: record["modelFamily"],
      tool: record["tool"],
      valueQuality: "exact",
      revision: 1,
      tokens: {
        input: "0",
        output: "0",
        cacheRead: "0",
        cacheWrite: "0",
        reasoning: "0",
        other: "0",
        total: "0",
      },
    });
    return Object.freeze({
      provider: bucket.provider,
      modelFamily: bucket.modelFamily,
      tool: bucket.tool,
    });
  } catch {
    return fail(
      "INVALID_CLOUD_MIRROR",
      "Cloud mirror presence key is invalid.",
    );
  }
}

export function parseMissingCloudZeroCorrectionQuery(
  input: unknown,
): MissingCloudZeroCorrectionQuery {
  const record = asStrictRecord(
    input,
    ["bucketStart", "completeScan", "collector", "presentKeys", "limit"],
    "INVALID_CLOUD_MIRROR",
    "Missing-key zero correction query is invalid.",
  );
  const presentKeysInput = record["presentKeys"];
  const limit = record["limit"];
  if (
    record["completeScan"] !== true ||
    !Array.isArray(presentKeysInput) ||
    presentKeysInput.length > MAX_CLOUD_MIRROR_ROWS ||
    !Number.isInteger(limit) ||
    (limit as number) < 1 ||
    (limit as number) > MAX_ZERO_CORRECTIONS
  ) {
    return fail(
      "INVALID_CLOUD_MIRROR",
      "Missing-key zero correction query is invalid.",
    );
  }
  const presentKeys = presentKeysInput.map(parseCloudMirrorPresenceKey);
  let collector;
  try {
    collector = SupportedCollectorIdentitySchema.parse(record["collector"]);
  } catch {
    return fail(
      "INVALID_CLOUD_MIRROR",
      "Missing-key zero correction collector is invalid.",
    );
  }
  const canonicalKeys = presentKeys.map((key) =>
    [key.provider, key.modelFamily, key.tool].join("|"),
  );
  if (new Set(canonicalKeys).size !== canonicalKeys.length) {
    return fail(
      "INVALID_CLOUD_MIRROR",
      "Missing-key zero correction query repeats a presence key.",
    );
  }
  return Object.freeze({
    bucketStart: parseUtcDay(
      record["bucketStart"],
      "INVALID_CLOUD_MIRROR",
      "Missing-key zero correction query is invalid.",
    ),
    completeScan: true,
    collector: Object.freeze(collector),
    presentKeys: Object.freeze(presentKeys),
    limit: limit as number,
  });
}

export function parseEnqueueOptions(
  input: unknown,
): EnqueueCloudSnapshotOptions {
  const record = asStrictRecord(
    input,
    ["nextAttemptAt", "expiresAt"],
    "INVALID_OUTBOX_ENTRY",
    "Cloud outbox scheduling metadata is invalid.",
  );
  return {
    nextAttemptAt: parseTimestamp(
      record["nextAttemptAt"],
      "INVALID_OUTBOX_ENTRY",
      "Cloud outbox scheduling metadata is invalid.",
    ),
    expiresAt: parseTimestamp(
      record["expiresAt"],
      "INVALID_OUTBOX_ENTRY",
      "Cloud outbox scheduling metadata is invalid.",
    ),
  };
}

export function assertOutboxRetention(
  generatedAt: string,
  options: EnqueueCloudSnapshotOptions,
): void {
  const generated = Date.parse(generatedAt);
  const next = Date.parse(options.nextAttemptAt);
  const expires = Date.parse(options.expiresAt);
  if (
    next < generated ||
    next > expires ||
    expires <= generated ||
    expires - generated > THIRTY_DAYS_MS
  ) {
    return fail(
      "INVALID_OUTBOX_ENTRY",
      "Cloud outbox retention must be positive and at most 30 days.",
    );
  }
}

export function parseDueCloudQuery(input: unknown): DueCloudSnapshotQuery {
  const record = asStrictRecord(
    input,
    ["now", "limit"],
    "INVALID_QUERY",
    "Cloud outbox query is invalid.",
  );
  const limit = record["limit"];
  if (
    !Number.isInteger(limit) ||
    (limit as number) < 1 ||
    (limit as number) > MAX_OUTBOX_ROWS
  ) {
    return fail("INVALID_QUERY", "Cloud outbox query is invalid.");
  }
  return {
    now: parseTimestamp(
      record["now"],
      "INVALID_QUERY",
      "Cloud outbox query is invalid.",
    ),
    limit: limit as number,
  };
}

export function parseRescheduleInput(
  input: unknown,
): RescheduleCloudSnapshotInput {
  const record = asStrictRecord(
    input,
    ["batchId", "nextAttemptAt", "errorCode"],
    "INVALID_OUTBOX_ENTRY",
    "Cloud outbox retry metadata is invalid.",
  );
  const batchId = record["batchId"];
  const errorCode = record["errorCode"];
  if (
    typeof batchId !== "string" ||
    !UUID_PATTERN.test(batchId) ||
    typeof errorCode !== "string" ||
    !CLOUD_OUTBOX_ERROR_CODES.includes(errorCode as CloudOutboxErrorCode)
  ) {
    return fail(
      "INVALID_OUTBOX_ENTRY",
      "Cloud outbox retry metadata is invalid.",
    );
  }
  return {
    batchId,
    nextAttemptAt: parseTimestamp(
      record["nextAttemptAt"],
      "INVALID_OUTBOX_ENTRY",
      "Cloud outbox retry metadata is invalid.",
    ),
    errorCode: errorCode as CloudOutboxErrorCode,
  };
}

export function parseBatchId(input: unknown): string {
  if (typeof input !== "string" || !UUID_PATTERN.test(input)) {
    return fail("INVALID_OUTBOX_ENTRY", "Cloud outbox batch ID is invalid.");
  }
  return input;
}

export function parseExportOptions(input: unknown): ContentBlindExportOptions {
  const record = asStrictRecord(
    input,
    ["maxDailyRows"],
    "INVALID_QUERY",
    "Content-blind export options are invalid.",
  );
  const maxDailyRows = record["maxDailyRows"];
  if (
    !Number.isInteger(maxDailyRows) ||
    (maxDailyRows as number) < 1 ||
    (maxDailyRows as number) > MAX_EXPORT_ROWS
  ) {
    return fail("INVALID_QUERY", "Content-blind export options are invalid.");
  }
  return { maxDailyRows: maxDailyRows as number };
}

export function parseOpenOptions(input: unknown): OpenLocalStoreOptions {
  const keys = ["path", ...(hasOwn(input, "clock") ? ["clock"] : [])];
  const record = asStrictRecord(
    input,
    keys,
    "INVALID_OPEN_OPTIONS",
    "Local store options are invalid.",
  );
  if (
    typeof record["path"] !== "string" ||
    record["path"].length === 0 ||
    (Object.hasOwn(record, "clock") && typeof record["clock"] !== "function")
  ) {
    return fail("INVALID_OPEN_OPTIONS", "Local store options are invalid.");
  }
  return {
    path: record["path"],
    ...(Object.hasOwn(record, "clock")
      ? { clock: record["clock"] as () => Date }
      : {}),
  };
}

export function canonicalClockTimestamp(clock: () => Date): string {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    return fail(
      "INVALID_OPEN_OPTIONS",
      "Local store clock returned an invalid time.",
    );
  }
  return value.toISOString();
}

export function assertSafeRevisionForIncrement(revision: number): void {
  if (revision >= MAX_SAFE_REVISION) {
    return fail(
      "REVISION_EXHAUSTED",
      "The daily aggregate revision cannot be incremented safely.",
    );
  }
}
