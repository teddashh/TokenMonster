import { chmodSync, existsSync, lstatSync, mkdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  DatabaseSync,
  backup,
  type StatementResultingChanges,
} from "node:sqlite";

import {
  CollectorIdentityV1Schema,
  DailyAggregateBucketV1Schema,
  IngestSnapshotV1Schema,
  type CollectorIdentityV1,
  type IngestSnapshotV1,
  type ProviderKindV1,
  type TokenCountsV1,
} from "@tokenmonster/contracts";
import {
  MonsterCharacterIdV1Schema,
  MonsterStateV1Schema,
} from "@tokenmonster/monster-engine";

import { LocalStoreError } from "./errors.js";
import {
  LOCAL_STORE_MIGRATIONS,
  LOCAL_STORE_SCHEMA_VERSION,
  expectedTablesForSchemaVersion,
} from "./schema.js";
import {
  COMPLETE_SCAN_CLIENTS,
  LOCAL_USAGE_INSIGHT_TOOLS,
  type CompleteDailyScanCoverage,
  type CollectorAuthorityInput,
  type CloudMirrorClearQuery,
  type CloudMirrorQuery,
  type ContentBlindExportOptions,
  type DailyAggregateQuery,
  type DailyUpsertResult,
  type DueCloudSnapshotQuery,
  type EnqueueCloudSnapshotOptions,
  type LocalCompanionConfigV1,
  type LocalContentBlindExportV1,
  type LocalStoreDiagnosticSummary,
  type LocalUsageInsightTool,
  type LocalUsageInsightsV1,
  type MissingCloudZeroCorrectionPlan,
  type MissingCloudZeroCorrectionQuery,
  type MonsterSnapshotInput,
  type MonsterUpsertResult,
  type OpenLocalStoreOptions,
  type ProjectedDailyAggregate,
  type QueuedCloudSnapshot,
  type RecordAcceptedCloudSnapshotResult,
  type RescheduleCloudSnapshotInput,
  type StoredCollectorAuthority,
  type StoredCloudMirrorRow,
  type StoredCompleteDailyScan,
  type StoredDailyAggregate,
  type StoredMonsterSnapshot,
} from "./types.js";
import {
  assertOutboxRetention,
  assertSafeRevisionForIncrement,
  canonicalClockTimestamp,
  parseCompleteDailyScanCoverageQuery,
  parseCompleteDailyScanInput,
  parseBatchId,
  parseAcceptedCloudSnapshot,
  parseCloudSnapshot,
  parseCloudMirrorClearQuery,
  parseCloudMirrorQuery,
  parseCollectorAuthority,
  parseDailyAggregateBatch,
  parseDailyAggregateQuery,
  parseDueCloudQuery,
  parseEnqueueOptions,
  parseExportOptions,
  parseLocalConfig,
  parseLocalUsageInsightsQuery,
  parseMonsterSnapshot,
  parseMissingCloudZeroCorrectionQuery,
  parseOpenOptions,
  parseProjectedDailyAggregate,
  parseRescheduleInput,
  parseTimestamp,
} from "./validation.js";

type SqlRow = Record<string, unknown>;

const DAY_MS = 86_400_000;
const COMPLETE_SCAN_RETENTION_DAYS = 35;
const LOCAL_USAGE_INSIGHT_PROVIDERS = [
  "anthropic",
  "google",
  "openai",
  "openrouter",
  "xai",
  "other",
] as const satisfies readonly ProviderKindV1[];
const LOCAL_USAGE_INSIGHT_TOOL_SET = new Set<string>(
  LOCAL_USAGE_INSIGHT_TOOLS.filter((tool) => tool !== "other"),
);

const DAILY_SELECT = `
  SELECT
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
    local_coverage,
    collector_kind,
    adapter_version,
    source_version,
    updated_at
  FROM usage_daily
`;

const DAILY_ORDER = " ORDER BY bucket_start, provider, model_family, tool";

const INSERT_DAILY = `
  INSERT INTO usage_daily (
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
    local_coverage,
    collector_kind,
    adapter_version,
    source_version,
    updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const UPDATE_DAILY = `
  UPDATE usage_daily SET
    value_quality = ?,
    revision = ?,
    input_tokens = ?,
    output_tokens = ?,
    cache_read_tokens = ?,
    cache_write_tokens = ?,
    reasoning_tokens = ?,
    other_tokens = ?,
    total_tokens = ?,
    local_coverage = ?,
    collector_kind = ?,
    adapter_version = ?,
    source_version = ?,
    updated_at = ?
  WHERE bucket_start = ? AND provider = ? AND model_family = ? AND tool = ?
`;

const UPDATE_DAILY_METADATA = `
  UPDATE usage_daily SET
    local_coverage = ?,
    collector_kind = ?,
    adapter_version = ?,
    source_version = ?,
    updated_at = ?
  WHERE bucket_start = ? AND provider = ? AND model_family = ? AND tool = ?
`;

const CLOUD_MIRROR_SELECT = `
  SELECT
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
    receipt_batch_id,
    receipt_received_at,
    updated_at
  FROM cloud_mirror
`;

const CLOUD_MIRROR_ORDER =
  " ORDER BY bucket_start, provider, model_family, tool";

const UPSERT_CLOUD_MIRROR = `
  INSERT INTO cloud_mirror (
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
    receipt_batch_id,
    receipt_received_at,
    updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (bucket_start, provider, model_family, tool) DO UPDATE SET
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
    receipt_batch_id = excluded.receipt_batch_id,
    receipt_received_at = excluded.receipt_received_at,
    updated_at = excluded.updated_at
`;

function contentFreeFailure(
  code: "CORRUPT_STORAGE" | "MIGRATION_FAILED" | "UNSUPPORTED_SCHEMA",
  message: string,
): never {
  throw new LocalStoreError(code, message);
}

function requiredString(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    return contentFreeFailure(
      "CORRUPT_STORAGE",
      "A local SQLite row failed integrity validation.",
    );
  }
  return value;
}

function safeInteger(row: SqlRow, key: string, minimum = 0): number {
  const value = row[key];
  const converted =
    typeof value === "bigint"
      ? value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(value)
        : Number.NaN
      : value;
  if (
    typeof converted !== "number" ||
    !Number.isSafeInteger(converted) ||
    converted < minimum
  ) {
    return contentFreeFailure(
      "CORRUPT_STORAGE",
      "A local SQLite integer failed integrity validation.",
    );
  }
  return converted;
}

function tokenString(row: SqlRow, key: string): string {
  return safeInteger(row, key).toString();
}

function localInsightProvider(input: string): ProviderKindV1 {
  const provider = LOCAL_USAGE_INSIGHT_PROVIDERS.find(
    (candidate) => candidate === input,
  );
  if (provider === undefined) {
    return contentFreeFailure(
      "CORRUPT_STORAGE",
      "A local usage insight provider failed integrity validation.",
    );
  }
  return provider;
}

function localInsightTool(input: string): LocalUsageInsightTool {
  return LOCAL_USAGE_INSIGHT_TOOL_SET.has(input)
    ? (input as LocalUsageInsightTool)
    : "other";
}

function addInsightTotal<Key extends string>(
  totals: Map<Key, bigint>,
  key: Key,
  value: bigint,
): void {
  totals.set(key, (totals.get(key) ?? 0n) + value);
}

function insightBreakdown<Key extends string>(
  totals: Map<Key, bigint>,
  grandTotal: bigint,
): readonly Readonly<{
  id: Key;
  totalTokens: string;
  shareBasisPoints: number;
}>[] {
  const rows = [...totals.entries()]
    .filter(([, total]) => total > 0n)
    .sort(([leftId, left], [rightId, right]) =>
      left === right ? leftId.localeCompare(rightId) : left > right ? -1 : 1,
    )
    .map(([id, total]) =>
      Object.freeze({
        id,
        totalTokens: total.toString(),
        shareBasisPoints:
          grandTotal === 0n
            ? 0
            : Number((total * 10_000n + grandTotal / 2n) / grandTotal),
      }),
    );
  return Object.freeze(rows);
}

function changesAsNumber(result: StatementResultingChanges): number {
  return typeof result.changes === "bigint"
    ? Number(result.changes)
    : result.changes;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return contentFreeFailure(
      "CORRUPT_STORAGE",
      "A local SQLite JSON value failed integrity validation.",
    );
  }
}

function rowToDaily(row: SqlRow): StoredDailyAggregate {
  try {
    const projection = parseProjectedDailyAggregate({
      bucketStart: requiredString(row, "bucket_start"),
      provider: requiredString(row, "provider"),
      modelFamily: requiredString(row, "model_family"),
      tool: requiredString(row, "tool"),
      valueQuality: requiredString(row, "value_quality"),
      tokens: {
        input: tokenString(row, "input_tokens"),
        output: tokenString(row, "output_tokens"),
        cacheRead: tokenString(row, "cache_read_tokens"),
        cacheWrite: tokenString(row, "cache_write_tokens"),
        reasoning: tokenString(row, "reasoning_tokens"),
        other: tokenString(row, "other_tokens"),
        total: tokenString(row, "total_tokens"),
      },
      localCoverage: requiredString(row, "local_coverage"),
      collector: {
        kind: requiredString(row, "collector_kind"),
        adapterVersion: requiredString(row, "adapter_version"),
        sourceVersion: requiredString(row, "source_version"),
      },
    });
    const revision = safeInteger(row, "revision", 1);
    const updatedAt = parseTimestamp(
      requiredString(row, "updated_at"),
      "CORRUPT_STORAGE",
      "A local SQLite timestamp failed integrity validation.",
    );
    return Object.freeze({ ...projection, revision, updatedAt });
  } catch (error: unknown) {
    if (error instanceof LocalStoreError && error.code === "CORRUPT_STORAGE") {
      throw error;
    }
    return contentFreeFailure(
      "CORRUPT_STORAGE",
      "A local daily aggregate failed integrity validation.",
    );
  }
}

function rowToCompleteDailyScan(row: SqlRow): StoredCompleteDailyScan {
  try {
    const scan = parseCompleteDailyScanInput({
      utcDate: requiredString(row, "utc_date"),
      client: requiredString(row, "client"),
    });
    const completedAt = parseTimestamp(
      requiredString(row, "completed_at"),
      "CORRUPT_STORAGE",
      "A complete scan timestamp failed integrity validation.",
    );
    return Object.freeze({ ...scan, completedAt });
  } catch (error: unknown) {
    if (error instanceof LocalStoreError && error.code === "CORRUPT_STORAGE") {
      throw error;
    }
    return contentFreeFailure(
      "CORRUPT_STORAGE",
      "Complete scan evidence failed integrity validation.",
    );
  }
}

function sameTokens(left: TokenCountsV1, right: TokenCountsV1): boolean {
  return (
    left.input === right.input &&
    left.output === right.output &&
    left.cacheRead === right.cacheRead &&
    left.cacheWrite === right.cacheWrite &&
    left.reasoning === right.reasoning &&
    left.other === right.other &&
    left.total === right.total
  );
}

function canonicalTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return contentFreeFailure(
      "CORRUPT_STORAGE",
      "A cloud receipt timestamp failed integrity validation.",
    );
  }
  return new Date(timestamp).toISOString();
}

function rowToCloudMirror(row: SqlRow): StoredCloudMirrorRow {
  try {
    const bucket = DailyAggregateBucketV1Schema.parse({
      bucketStart: requiredString(row, "bucket_start"),
      provider: requiredString(row, "provider"),
      modelFamily: requiredString(row, "model_family"),
      tool: requiredString(row, "tool"),
      valueQuality: requiredString(row, "value_quality"),
      revision: safeInteger(row, "revision", 1),
      tokens: {
        input: tokenString(row, "input_tokens"),
        output: tokenString(row, "output_tokens"),
        cacheRead: tokenString(row, "cache_read_tokens"),
        cacheWrite: tokenString(row, "cache_write_tokens"),
        reasoning: tokenString(row, "reasoning_tokens"),
        other: tokenString(row, "other_tokens"),
        total: tokenString(row, "total_tokens"),
      },
    });
    const collector = CollectorIdentityV1Schema.parse({
      kind: requiredString(row, "collector_kind"),
      adapterVersion: requiredString(row, "adapter_version"),
      sourceVersion: requiredString(row, "source_version"),
    });
    const receipt = Object.freeze({
      batchId: parseBatchId(requiredString(row, "receipt_batch_id")),
      receivedAt: parseTimestamp(
        requiredString(row, "receipt_received_at"),
        "CORRUPT_STORAGE",
        "A cloud mirror receipt timestamp failed integrity validation.",
      ),
    });
    const updatedAt = parseTimestamp(
      requiredString(row, "updated_at"),
      "CORRUPT_STORAGE",
      "A local SQLite timestamp failed integrity validation.",
    );
    return Object.freeze({ bucket, collector, receipt, updatedAt });
  } catch (error: unknown) {
    if (error instanceof LocalStoreError && error.code === "CORRUPT_STORAGE") {
      throw error;
    }
    return contentFreeFailure(
      "CORRUPT_STORAGE",
      "A cloud mirror row failed integrity validation.",
    );
  }
}

function sameCloudMirrorValue(
  existing: StoredCloudMirrorRow,
  bucket: StoredCloudMirrorRow["bucket"],
  collector: CollectorIdentityV1,
): boolean {
  return (
    existing.bucket.valueQuality === bucket.valueQuality &&
    sameTokens(existing.bucket.tokens, bucket.tokens) &&
    sameCollector(existing.collector, collector)
  );
}

function cloudMirrorBindings(
  bucket: StoredCloudMirrorRow["bucket"],
  collector: CollectorIdentityV1,
  receipt: StoredCloudMirrorRow["receipt"],
  updatedAt: string,
): readonly (string | bigint)[] {
  return [
    bucket.bucketStart,
    bucket.provider,
    bucket.modelFamily,
    bucket.tool,
    bucket.valueQuality,
    BigInt(bucket.revision),
    BigInt(bucket.tokens.input),
    BigInt(bucket.tokens.output),
    BigInt(bucket.tokens.cacheRead),
    BigInt(bucket.tokens.cacheWrite),
    BigInt(bucket.tokens.reasoning),
    BigInt(bucket.tokens.other),
    BigInt(bucket.tokens.total),
    collector.kind,
    collector.adapterVersion,
    collector.sourceVersion,
    receipt.batchId,
    receipt.receivedAt,
    updatedAt,
  ];
}

function sameCollector(
  left: CollectorIdentityV1,
  right: CollectorIdentityV1,
): boolean {
  return (
    left.kind === right.kind &&
    left.adapterVersion === right.adapterVersion &&
    left.sourceVersion === right.sourceVersion
  );
}

function dailyBindings(
  row: ProjectedDailyAggregate,
  revision: number,
  updatedAt: string,
): readonly (string | bigint)[] {
  return [
    row.bucketStart,
    row.provider,
    row.modelFamily,
    row.tool,
    row.valueQuality,
    BigInt(revision),
    BigInt(row.tokens.input),
    BigInt(row.tokens.output),
    BigInt(row.tokens.cacheRead),
    BigInt(row.tokens.cacheWrite),
    BigInt(row.tokens.reasoning),
    BigInt(row.tokens.other),
    BigInt(row.tokens.total),
    row.localCoverage,
    row.collector.kind,
    row.collector.adapterVersion,
    row.collector.sourceVersion,
    updatedAt,
  ];
}

function getUserVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as
    SqlRow | undefined;
  if (row === undefined) {
    return contentFreeFailure(
      "CORRUPT_STORAGE",
      "Local SQLite did not report a schema version.",
    );
  }
  return safeInteger(row, "user_version");
}

function listApplicationTables(database: DatabaseSync): readonly string[] {
  const rows = database
    .prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all() as SqlRow[];
  return rows.map((row) => requiredString(row, "name"));
}

function assertExpectedTables(database: DatabaseSync, version: number): void {
  const actual = listApplicationTables(database);
  const expected = [...expectedTablesForSchemaVersion(version)].sort();
  if (
    actual.length !== expected.length ||
    actual.some((table, index) => table !== expected[index])
  ) {
    return contentFreeFailure(
      "UNSUPPORTED_SCHEMA",
      "Local SQLite contains an unexpected schema.",
    );
  }
}

function configurePreMigrationPragmas(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA trusted_schema = OFF;
    PRAGMA secure_delete = ON;
    PRAGMA temp_store = MEMORY;
  `);
}

function configureJournalMode(
  database: DatabaseSync,
  storage: "memory" | "file",
): "memory" | "wal" {
  const row = database.prepare("PRAGMA journal_mode = WAL").get() as
    SqlRow | undefined;
  if (row === undefined) {
    return contentFreeFailure(
      "MIGRATION_FAILED",
      "Local SQLite journal mode could not be configured.",
    );
  }
  const mode = requiredString(row, "journal_mode").toLowerCase();
  const expected = storage === "memory" ? "memory" : "wal";
  if (mode !== expected) {
    return contentFreeFailure(
      "MIGRATION_FAILED",
      "Local SQLite journal mode could not be configured.",
    );
  }
  return expected;
}

function runMigrations(
  database: DatabaseSync,
  fromVersion: number,
  now: string,
): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const migration of LOCAL_STORE_MIGRATIONS) {
      if (migration.version <= fromVersion) continue;
      database.exec(migration.sql);
      database.exec(`PRAGMA user_version = ${migration.version}`);
    }
    database
      .prepare(
        `INSERT INTO app_meta (key, value, updated_at)
         VALUES ('schema_version', ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run(LOCAL_STORE_SCHEMA_VERSION.toString(), now);
    database.exec("COMMIT");
  } catch {
    try {
      database.exec("ROLLBACK");
    } catch {
      // The original migration error remains the only surfaced failure.
    }
    return contentFreeFailure(
      "MIGRATION_FAILED",
      "Local SQLite migration failed without exposing stored data.",
    );
  }
}

async function createMigrationBackup(
  database: DatabaseSync,
  databasePath: string,
  fromVersion: number,
): Promise<void> {
  const directory = dirname(databasePath);
  const stem = `.tokenmonster-pre-migration-v${fromVersion}-to-v${LOCAL_STORE_SCHEMA_VERSION}-${Date.now()}`;
  let backupPath = join(directory, `${stem}.sqlite`);
  let suffix = 0;
  while (existsSync(backupPath)) {
    suffix += 1;
    backupPath = join(directory, `${stem}-${suffix}.sqlite`);
  }
  try {
    await backup(database, backupPath);
    chmodSync(backupPath, 0o600);
  } catch {
    return contentFreeFailure(
      "MIGRATION_FAILED",
      "Local SQLite could not create its pre-migration backup.",
    );
  }
}

function verifyDatabaseIntegrity(database: DatabaseSync): void {
  const row = database.prepare("PRAGMA quick_check").get() as
    SqlRow | undefined;
  if (row === undefined || requiredString(row, "quick_check") !== "ok") {
    return contentFreeFailure(
      "CORRUPT_STORAGE",
      "Local SQLite failed its integrity check.",
    );
  }
}

export class LocalStore {
  readonly #database: DatabaseSync;
  readonly #storage: "memory" | "file";
  readonly #journalMode: "memory" | "wal";
  readonly #clock: () => Date;
  #closed = false;

  constructor(
    database: DatabaseSync,
    storage: "memory" | "file",
    journalMode: "memory" | "wal",
    clock: () => Date,
  ) {
    this.#database = database;
    this.#storage = storage;
    this.#journalMode = journalMode;
    this.#clock = clock;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new LocalStoreError("STORE_CLOSED", "The local store is closed.");
    }
  }

  #now(): string {
    return canonicalClockTimestamp(this.#clock);
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error: unknown) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // Preserve the content-free domain error or SQLite failure from operation.
      }
      throw error;
    }
  }

  #selectDailyByKey(row: ProjectedDailyAggregate): StoredDailyAggregate | null {
    const result = this.#database
      .prepare(
        `${DAILY_SELECT}
         WHERE bucket_start = ? AND provider = ? AND model_family = ? AND tool = ?`,
      )
      .get(row.bucketStart, row.provider, row.modelFamily, row.tool) as
      SqlRow | undefined;
    return result === undefined ? null : rowToDaily(result);
  }

  #selectCloudMirrorByKey(
    bucket: StoredCloudMirrorRow["bucket"],
  ): StoredCloudMirrorRow | null {
    const result = this.#database
      .prepare(
        `${CLOUD_MIRROR_SELECT}
         WHERE bucket_start = ? AND provider = ? AND model_family = ? AND tool = ?`,
      )
      .get(
        bucket.bucketStart,
        bucket.provider,
        bucket.modelFamily,
        bucket.tool,
      ) as SqlRow | undefined;
    return result === undefined ? null : rowToCloudMirror(result);
  }

  #upsertOneDaily(
    row: ProjectedDailyAggregate,
    updatedAt: string,
  ): DailyUpsertResult {
    const existing = this.#selectDailyByKey(row);
    if (existing === null) {
      this.#database
        .prepare(INSERT_DAILY)
        .run(...dailyBindings(row, 1, updatedAt));
      return Object.freeze({
        status: "inserted",
        row: Object.freeze({ ...row, revision: 1, updatedAt }),
      });
    }

    const projectionChanged =
      existing.valueQuality !== row.valueQuality ||
      !sameTokens(existing.tokens, row.tokens);
    const metadataChanged =
      existing.localCoverage !== row.localCoverage ||
      !sameCollector(existing.collector, row.collector);

    if (!projectionChanged && !metadataChanged) {
      return Object.freeze({ status: "unchanged", row: existing });
    }

    if (!projectionChanged) {
      this.#database
        .prepare(UPDATE_DAILY_METADATA)
        .run(
          row.localCoverage,
          row.collector.kind,
          row.collector.adapterVersion,
          row.collector.sourceVersion,
          updatedAt,
          row.bucketStart,
          row.provider,
          row.modelFamily,
          row.tool,
        );
      return Object.freeze({
        status: "metadata-updated",
        row: Object.freeze({
          ...row,
          revision: existing.revision,
          updatedAt,
        }),
      });
    }

    assertSafeRevisionForIncrement(existing.revision);
    const revision = existing.revision + 1;
    const bindings = dailyBindings(row, revision, updatedAt);
    this.#database
      .prepare(UPDATE_DAILY)
      .run(
        ...bindings.slice(4),
        row.bucketStart,
        row.provider,
        row.modelFamily,
        row.tool,
      );
    return Object.freeze({
      status: "updated",
      row: Object.freeze({ ...row, revision, updatedAt }),
    });
  }

  upsertDailyAggregate(input: unknown): DailyUpsertResult {
    this.#assertOpen();
    const row = parseProjectedDailyAggregate(input);
    return this.#transaction(() => this.#upsertOneDaily(row, this.#now()));
  }

  upsertDailyAggregates(
    input: readonly unknown[],
  ): readonly DailyUpsertResult[] {
    this.#assertOpen();
    const rows = parseDailyAggregateBatch(input);
    if (rows.length === 0) return Object.freeze([]);
    const updatedAt = this.#now();
    return this.#transaction(() =>
      Object.freeze(rows.map((row) => this.#upsertOneDaily(row, updatedAt))),
    );
  }

  listDailyAggregates(
    input: DailyAggregateQuery,
  ): readonly StoredDailyAggregate[] {
    this.#assertOpen();
    const query = parseDailyAggregateQuery(input);
    let rows: SqlRow[];
    if (query.fromInclusive !== undefined && query.toExclusive !== undefined) {
      rows = this.#database
        .prepare(
          `${DAILY_SELECT} WHERE bucket_start >= ? AND bucket_start < ?${DAILY_ORDER} LIMIT ?`,
        )
        .all(query.fromInclusive, query.toExclusive, query.limit) as SqlRow[];
    } else if (query.fromInclusive !== undefined) {
      rows = this.#database
        .prepare(
          `${DAILY_SELECT} WHERE bucket_start >= ?${DAILY_ORDER} LIMIT ?`,
        )
        .all(query.fromInclusive, query.limit) as SqlRow[];
    } else if (query.toExclusive !== undefined) {
      rows = this.#database
        .prepare(`${DAILY_SELECT} WHERE bucket_start < ?${DAILY_ORDER} LIMIT ?`)
        .all(query.toExclusive, query.limit) as SqlRow[];
    } else {
      rows = this.#database
        .prepare(`${DAILY_SELECT}${DAILY_ORDER} LIMIT ?`)
        .all(query.limit) as SqlRow[];
    }
    return Object.freeze(rows.map(rowToDaily));
  }

  getLocalUsageInsights(input: unknown): LocalUsageInsightsV1 {
    this.#assertOpen();
    const query = parseLocalUsageInsightsQuery(input);
    const now = this.#now();
    const todayStart = Date.parse(`${now.slice(0, 10)}T00:00:00.000Z`);
    const fromInclusive = new Date(
      todayStart - (query.windowDays - 1) * DAY_MS,
    ).toISOString();
    const toExclusive = new Date(todayStart + DAY_MS).toISOString();
    const providerTotals = new Map<ProviderKindV1, bigint>();
    const toolTotals = new Map<LocalUsageInsightTool, bigint>();
    let totalTokens = 0n;
    const statement = this.#database.prepare(
      `SELECT provider, tool, total_tokens
       FROM usage_daily
       WHERE bucket_start >= ? AND bucket_start < ?
       ORDER BY bucket_start, provider, model_family, tool`,
    );
    for (const rawRow of statement.iterate(fromInclusive, toExclusive)) {
      const row = rawRow as SqlRow;
      const provider = localInsightProvider(requiredString(row, "provider"));
      const tool = localInsightTool(requiredString(row, "tool"));
      const tokens = BigInt(tokenString(row, "total_tokens"));
      totalTokens += tokens;
      addInsightTotal(providerTotals, provider, tokens);
      addInsightTotal(toolTotals, tool, tokens);
    }
    return Object.freeze({
      schemaVersion: "1" as const,
      windowDays: query.windowDays,
      fromInclusive,
      toExclusive,
      totalTokens: totalTokens.toString(),
      providers: insightBreakdown(providerTotals, totalTokens),
      tools: insightBreakdown(toolTotals, totalTokens),
    });
  }

  recordCompleteDailyScan(input: unknown): StoredCompleteDailyScan {
    this.#assertOpen();
    const scan = parseCompleteDailyScanInput(input);
    const completedAt = this.#now();
    const retentionStart = new Date(
      Date.parse(completedAt) - (COMPLETE_SCAN_RETENTION_DAYS - 1) * DAY_MS,
    )
      .toISOString()
      .slice(0, 10);
    if (
      scan.utcDate < retentionStart ||
      scan.utcDate > completedAt.slice(0, 10)
    ) {
      throw new LocalStoreError(
        "INVALID_SCAN_LEDGER",
        "Complete scan evidence is outside the bounded retention window.",
      );
    }
    return this.#transaction(() => {
      this.#database
        .prepare("DELETE FROM complete_scan_ledger WHERE utc_date < ?")
        .run(retentionStart);
      this.#database
        .prepare(
          `INSERT INTO complete_scan_ledger (utc_date, client, completed_at)
           VALUES (?, ?, ?)
           ON CONFLICT (utc_date, client) DO UPDATE SET
             completed_at = excluded.completed_at
           WHERE excluded.completed_at > complete_scan_ledger.completed_at`,
        )
        .run(scan.utcDate, scan.client, completedAt);
      const row = this.#database
        .prepare(
          `SELECT utc_date, client, completed_at
           FROM complete_scan_ledger
           WHERE utc_date = ? AND client = ?`,
        )
        .get(scan.utcDate, scan.client) as SqlRow | undefined;
      if (row === undefined) {
        return contentFreeFailure(
          "CORRUPT_STORAGE",
          "Complete scan evidence was not retained atomically.",
        );
      }
      return rowToCompleteDailyScan(row);
    });
  }

  getCompleteDailyScanCoverage(input: unknown): CompleteDailyScanCoverage {
    this.#assertOpen();
    const query = parseCompleteDailyScanCoverageQuery(input);
    const rows = this.#database
      .prepare(
        `SELECT utc_date, client, completed_at
         FROM complete_scan_ledger
         WHERE utc_date = ?`,
      )
      .all(query.utcDate) as SqlRow[];
    const records = rows.map(rowToCompleteDailyScan);
    const recordedClients = new Set(records.map((record) => record.client));
    const completedClients = COMPLETE_SCAN_CLIENTS.filter((client) =>
      recordedClients.has(client),
    );
    if (completedClients.length !== records.length) {
      return contentFreeFailure(
        "CORRUPT_STORAGE",
        "Complete scan evidence contains duplicate client scopes.",
      );
    }
    return Object.freeze({
      utcDate: query.utcDate,
      completedClients: Object.freeze(completedClients),
      complete: completedClients.length === COMPLETE_SCAN_CLIENTS.length,
    });
  }

  recordAcceptedCloudSnapshot(
    snapshotInput: unknown,
    receiptInput: unknown,
  ): RecordAcceptedCloudSnapshotResult {
    this.#assertOpen();
    const { snapshot, receipt } = parseAcceptedCloudSnapshot(
      snapshotInput,
      receiptInput,
    );
    const receiptReference = Object.freeze({
      batchId: receipt.batchId,
      receivedAt: canonicalTimestamp(receipt.receivedAt),
    });
    const updatedAt = this.#now();

    return this.#transaction(() => {
      const planned = snapshot.buckets.map((bucket) => {
        const existing = this.#selectCloudMirrorByKey(bucket);
        if (existing === null) {
          return Object.freeze({
            status: "inserted" as const,
            bucket,
            existing,
          });
        }
        if (bucket.revision < existing.bucket.revision) {
          throw new LocalStoreError(
            "CLOUD_MIRROR_STALE",
            "An accepted cloud row is older than the retained mirror.",
          );
        }
        if (bucket.revision === existing.bucket.revision) {
          if (!sameCloudMirrorValue(existing, bucket, snapshot.collector)) {
            throw new LocalStoreError(
              "CLOUD_MIRROR_REVISION_CONFLICT",
              "Equal cloud mirror revisions contain different accepted state.",
            );
          }
          return Object.freeze({
            status: "idempotent" as const,
            bucket,
            existing,
          });
        }
        return Object.freeze({
          status: "updated" as const,
          bucket,
          existing,
        });
      });

      const decisions = planned.map(({ status, bucket }) => {
        this.#database
          .prepare(UPSERT_CLOUD_MIRROR)
          .run(
            ...cloudMirrorBindings(
              bucket,
              snapshot.collector,
              receiptReference,
              updatedAt,
            ),
          );
        const row = Object.freeze({
          bucket,
          collector: snapshot.collector,
          receipt: receiptReference,
          updatedAt,
        });
        return Object.freeze({ status, row });
      });
      return Object.freeze({ receipt, decisions: Object.freeze(decisions) });
    });
  }

  listCloudMirror(input: CloudMirrorQuery): readonly StoredCloudMirrorRow[] {
    this.#assertOpen();
    const query = parseCloudMirrorQuery(input);
    let rows: SqlRow[];
    if (query.fromInclusive !== undefined && query.toExclusive !== undefined) {
      rows = this.#database
        .prepare(
          `${CLOUD_MIRROR_SELECT} WHERE bucket_start >= ? AND bucket_start < ?${CLOUD_MIRROR_ORDER} LIMIT ?`,
        )
        .all(query.fromInclusive, query.toExclusive, query.limit) as SqlRow[];
    } else if (query.fromInclusive !== undefined) {
      rows = this.#database
        .prepare(
          `${CLOUD_MIRROR_SELECT} WHERE bucket_start >= ?${CLOUD_MIRROR_ORDER} LIMIT ?`,
        )
        .all(query.fromInclusive, query.limit) as SqlRow[];
    } else if (query.toExclusive !== undefined) {
      rows = this.#database
        .prepare(
          `${CLOUD_MIRROR_SELECT} WHERE bucket_start < ?${CLOUD_MIRROR_ORDER} LIMIT ?`,
        )
        .all(query.toExclusive, query.limit) as SqlRow[];
    } else {
      rows = this.#database
        .prepare(`${CLOUD_MIRROR_SELECT}${CLOUD_MIRROR_ORDER} LIMIT ?`)
        .all(query.limit) as SqlRow[];
    }
    return Object.freeze(rows.map(rowToCloudMirror));
  }

  clearCloudMirror(input: CloudMirrorClearQuery): number {
    this.#assertOpen();
    const query = parseCloudMirrorClearQuery(input);
    const where =
      query.beforeExclusive === undefined ? "" : "WHERE bucket_start < ?";
    const statement = this.#database.prepare(`
      DELETE FROM cloud_mirror
      WHERE (bucket_start, provider, model_family, tool) IN (
        SELECT bucket_start, provider, model_family, tool
        FROM cloud_mirror
        ${where}
        ORDER BY bucket_start, provider, model_family, tool
        LIMIT ?
      )
    `);
    const result =
      query.beforeExclusive === undefined
        ? statement.run(query.limit)
        : statement.run(query.beforeExclusive, query.limit);
    return changesAsNumber(result);
  }

  planMissingCloudZeroCorrections(
    input: MissingCloudZeroCorrectionQuery,
  ): MissingCloudZeroCorrectionPlan {
    this.#assertOpen();
    const query = parseMissingCloudZeroCorrectionQuery(input);
    const rows = this.#database
      .prepare(
        `${CLOUD_MIRROR_SELECT}
         WHERE bucket_start = ?${CLOUD_MIRROR_ORDER} LIMIT 1001`,
      )
      .all(query.bucketStart) as SqlRow[];
    if (rows.length > 1_000) {
      throw new LocalStoreError(
        "BATCH_TOO_LARGE",
        "A UTC day has too many mirror keys for a complete correction plan.",
      );
    }
    const present = new Set(
      query.presentKeys.map((key) =>
        [key.provider, key.modelFamily, key.tool].join("|"),
      ),
    );
    const candidates = rows
      .map(rowToCloudMirror)
      .filter(
        ({ bucket }) =>
          !present.has(
            [bucket.provider, bucket.modelFamily, bucket.tool].join("|"),
          ) && bucket.tokens.total !== "0",
      );
    if (
      candidates.some((row) => !sameCollector(row.collector, query.collector))
    ) {
      throw new LocalStoreError(
        "INVALID_CLOUD_MIRROR",
        "A missing-key plan cannot cross collector authority versions.",
      );
    }
    const corrections = candidates.slice(0, query.limit).map((row) => {
      assertSafeRevisionForIncrement(row.bucket.revision);
      return Object.freeze({
        bucket: Object.freeze({
          ...row.bucket,
          revision: row.bucket.revision + 1,
          tokens: Object.freeze({
            input: "0",
            output: "0",
            cacheRead: "0",
            cacheWrite: "0",
            reasoning: "0",
            other: "0",
            total: "0",
          }),
        }),
        collector: query.collector,
      });
    });
    return Object.freeze({
      corrections: Object.freeze(corrections),
      truncated: candidates.length > corrections.length,
    });
  }

  setCollectorAuthority(
    input: CollectorAuthorityInput,
  ): StoredCollectorAuthority {
    this.#assertOpen();
    const authority = parseCollectorAuthority(input);
    const existing = this.getCollectorAuthority();
    if (
      existing !== null &&
      (existing.kind !== authority.kind ||
        existing.adapterVersion !== authority.adapterVersion ||
        existing.sourceVersion !== authority.sourceVersion)
    ) {
      throw new LocalStoreError(
        "INVALID_AUTHORITY",
        "Collector authority cannot change until collector-derived state is reset.",
      );
    }
    const updatedAt = this.#now();
    this.#database
      .prepare(
        `INSERT INTO collector_authority (
           singleton, kind, state, adapter_version, source_version, updated_at
         ) VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           kind = excluded.kind,
           state = excluded.state,
           adapter_version = excluded.adapter_version,
           source_version = excluded.source_version,
           updated_at = excluded.updated_at`,
      )
      .run(
        authority.kind,
        authority.state,
        authority.adapterVersion,
        authority.sourceVersion,
        updatedAt,
      );
    return Object.freeze({ ...authority, updatedAt });
  }

  getCollectorAuthority(): StoredCollectorAuthority | null {
    this.#assertOpen();
    const row = this.#database
      .prepare(
        `SELECT kind, state, adapter_version, source_version, updated_at
         FROM collector_authority WHERE singleton = 1`,
      )
      .get() as SqlRow | undefined;
    if (row === undefined) return null;
    try {
      const authority = parseCollectorAuthority({
        kind: requiredString(row, "kind"),
        state: requiredString(row, "state"),
        adapterVersion: requiredString(row, "adapter_version"),
        sourceVersion: requiredString(row, "source_version"),
      });
      const updatedAt = parseTimestamp(
        requiredString(row, "updated_at"),
        "CORRUPT_STORAGE",
        "A local SQLite timestamp failed integrity validation.",
      );
      return Object.freeze({ ...authority, updatedAt });
    } catch {
      return contentFreeFailure(
        "CORRUPT_STORAGE",
        "Collector authority failed integrity validation.",
      );
    }
  }

  clearCollectorAuthority(): boolean {
    this.#assertOpen();
    return this.#transaction(() => {
      const removed =
        changesAsNumber(
          this.#database
            .prepare("DELETE FROM collector_authority WHERE singleton = 1")
            .run(),
        ) === 1;
      // Authority reset is the explicit local source-reset boundary. Keeping
      // any derived rows or scan evidence would let the next authority claim
      // observations produced by a different parser/version.
      for (const table of [
        "usage_daily",
        "complete_scan_ledger",
        "cloud_outbox",
        "cloud_mirror",
        "monster_state",
      ] as const) {
        this.#database.prepare(`DELETE FROM ${table}`).run();
      }
      this.#database
        .prepare("DELETE FROM app_meta WHERE key = 'last_successful_scan_at'")
        .run();
      return removed;
    });
  }

  setLastSuccessfulScanAt(input: string): string {
    this.#assertOpen();
    const scannedAt = parseTimestamp(
      input,
      "INVALID_CONFIG",
      "The last successful scan timestamp is invalid.",
    );
    this.#database
      .prepare(
        `INSERT INTO app_meta (key, value, updated_at)
         VALUES ('last_successful_scan_at', ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run(scannedAt, this.#now());
    return scannedAt;
  }

  getLastSuccessfulScanAt(): string | null {
    this.#assertOpen();
    const row = this.#database
      .prepare(
        "SELECT value FROM app_meta WHERE key = 'last_successful_scan_at'",
      )
      .get() as SqlRow | undefined;
    if (row === undefined) return null;
    return parseTimestamp(
      requiredString(row, "value"),
      "CORRUPT_STORAGE",
      "The stored last successful scan timestamp is invalid.",
    );
  }

  saveConfig(input: LocalCompanionConfigV1): LocalCompanionConfigV1 {
    this.#assertOpen();
    const config = parseLocalConfig(input);
    const serialized = JSON.stringify(config);
    this.#database
      .prepare(
        `INSERT INTO local_config (
           singleton, schema_version, config_json, updated_at
         ) VALUES (1, '1', ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           schema_version = excluded.schema_version,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`,
      )
      .run(serialized, this.#now());
    return config;
  }

  getConfig(): LocalCompanionConfigV1 | null {
    this.#assertOpen();
    const row = this.#database
      .prepare("SELECT config_json FROM local_config WHERE singleton = 1")
      .get() as SqlRow | undefined;
    if (row === undefined) return null;
    try {
      return parseLocalConfig(parseJson(requiredString(row, "config_json")));
    } catch {
      return contentFreeFailure(
        "CORRUPT_STORAGE",
        "Local configuration failed integrity validation.",
      );
    }
  }

  upsertMonsterSnapshot(input: MonsterSnapshotInput): MonsterUpsertResult {
    this.#assertOpen();
    const snapshot = parseMonsterSnapshot(input);
    const existing = this.getMonsterSnapshot(snapshot.state.characterId);
    if (existing !== null) {
      if (snapshot.asOfRevision < existing.asOfRevision) {
        return Object.freeze({ status: "stale", snapshot: existing });
      }
      if (snapshot.asOfRevision === existing.asOfRevision) {
        if (JSON.stringify(snapshot.state) === JSON.stringify(existing.state)) {
          return Object.freeze({ status: "unchanged", snapshot: existing });
        }
        throw new LocalStoreError(
          "MONSTER_REVISION_CONFLICT",
          "Equal monster revisions cannot contain different state.",
        );
      }
    }

    const updatedAt = this.#now();
    this.#database
      .prepare(
        `INSERT INTO monster_state (
           character_id, engine_version, state_json, as_of_revision, updated_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(character_id) DO UPDATE SET
           engine_version = excluded.engine_version,
           state_json = excluded.state_json,
           as_of_revision = excluded.as_of_revision,
           updated_at = excluded.updated_at`,
      )
      .run(
        snapshot.state.characterId,
        snapshot.state.engineVersion,
        JSON.stringify(snapshot.state),
        BigInt(snapshot.asOfRevision),
        updatedAt,
      );
    const stored = Object.freeze({ ...snapshot, updatedAt });
    return Object.freeze({
      status: existing === null ? "inserted" : "updated",
      snapshot: stored,
    });
  }

  getMonsterSnapshot(characterIdInput: string): StoredMonsterSnapshot | null {
    this.#assertOpen();
    const character = MonsterCharacterIdV1Schema.safeParse(characterIdInput);
    if (!character.success) {
      throw new LocalStoreError(
        "INVALID_QUERY",
        "Monster snapshot character is invalid.",
      );
    }
    const row = this.#database
      .prepare(
        `SELECT state_json, as_of_revision, updated_at
         FROM monster_state WHERE character_id = ?`,
      )
      .get(character.data) as SqlRow | undefined;
    if (row === undefined) return null;
    try {
      const state = MonsterStateV1Schema.parse(
        parseJson(requiredString(row, "state_json")),
      );
      const asOfRevision = safeInteger(row, "as_of_revision", 1);
      const updatedAt = parseTimestamp(
        requiredString(row, "updated_at"),
        "CORRUPT_STORAGE",
        "A local SQLite timestamp failed integrity validation.",
      );
      return Object.freeze({ state, asOfRevision, updatedAt });
    } catch (error: unknown) {
      if (
        error instanceof LocalStoreError &&
        error.code === "CORRUPT_STORAGE"
      ) {
        throw error;
      }
      return contentFreeFailure(
        "CORRUPT_STORAGE",
        "Monster state failed integrity validation.",
      );
    }
  }

  enqueueCloudSnapshot(
    snapshotInput: unknown,
    optionsInput: EnqueueCloudSnapshotOptions,
  ): "inserted" | "idempotent" {
    this.#assertOpen();
    const snapshot = parseCloudSnapshot(snapshotInput);
    const options = parseEnqueueOptions(optionsInput);
    assertOutboxRetention(snapshot.generatedAt, options);
    const serialized = JSON.stringify(snapshot);
    const existing = this.#database
      .prepare("SELECT payload_json FROM cloud_outbox WHERE batch_id = ?")
      .get(snapshot.batchId) as SqlRow | undefined;
    if (existing !== undefined) {
      if (requiredString(existing, "payload_json") !== serialized) {
        throw new LocalStoreError(
          "OUTBOX_BATCH_CONFLICT",
          "A cloud outbox batch ID was reused with another payload.",
        );
      }
      return "idempotent";
    }
    this.#database
      .prepare(
        `INSERT INTO cloud_outbox (
           batch_id, generated_at, payload_json, attempts, next_attempt_at,
           expires_at, last_error_code, created_at
         ) VALUES (?, ?, ?, 0, ?, ?, NULL, ?)`,
      )
      .run(
        snapshot.batchId,
        snapshot.generatedAt,
        serialized,
        options.nextAttemptAt,
        options.expiresAt,
        this.#now(),
      );
    return "inserted";
  }

  listDueCloudSnapshots(
    input: DueCloudSnapshotQuery,
  ): readonly QueuedCloudSnapshot[] {
    this.#assertOpen();
    const query = parseDueCloudQuery(input);
    const rows = this.#database
      .prepare(
        `SELECT payload_json, attempts, next_attempt_at, expires_at, last_error_code
         FROM cloud_outbox
         WHERE next_attempt_at <= ? AND expires_at > ?
         ORDER BY next_attempt_at, batch_id
         LIMIT ?`,
      )
      .all(query.now, query.now, query.limit) as SqlRow[];
    return Object.freeze(
      rows.map((row) => {
        try {
          const snapshot = IngestSnapshotV1Schema.parse(
            parseJson(requiredString(row, "payload_json")),
          );
          const lastError = row["last_error_code"];
          return Object.freeze({
            snapshot,
            attempts: safeInteger(row, "attempts"),
            nextAttemptAt: parseTimestamp(
              requiredString(row, "next_attempt_at"),
              "CORRUPT_STORAGE",
              "A local SQLite timestamp failed integrity validation.",
            ),
            expiresAt: parseTimestamp(
              requiredString(row, "expires_at"),
              "CORRUPT_STORAGE",
              "A local SQLite timestamp failed integrity validation.",
            ),
            lastErrorCode:
              lastError === null
                ? null
                : (requiredString(
                    row,
                    "last_error_code",
                  ) as QueuedCloudSnapshot["lastErrorCode"]),
          });
        } catch (error: unknown) {
          if (
            error instanceof LocalStoreError &&
            error.code === "CORRUPT_STORAGE"
          ) {
            throw error;
          }
          return contentFreeFailure(
            "CORRUPT_STORAGE",
            "Cloud outbox state failed integrity validation.",
          );
        }
      }),
    );
  }

  rescheduleCloudSnapshot(input: RescheduleCloudSnapshotInput): boolean {
    this.#assertOpen();
    const retry = parseRescheduleInput(input);
    const existing = this.#database
      .prepare(
        "SELECT expires_at, attempts FROM cloud_outbox WHERE batch_id = ?",
      )
      .get(retry.batchId) as SqlRow | undefined;
    if (existing === undefined) return false;
    const expiresAt = parseTimestamp(
      requiredString(existing, "expires_at"),
      "CORRUPT_STORAGE",
      "A local SQLite timestamp failed integrity validation.",
    );
    const attempts = safeInteger(existing, "attempts");
    if (retry.nextAttemptAt > expiresAt || attempts >= 1_000_000) {
      throw new LocalStoreError(
        "INVALID_OUTBOX_ENTRY",
        "Cloud outbox retry exceeds its retention or attempt bound.",
      );
    }
    this.#database
      .prepare(
        `UPDATE cloud_outbox SET
           attempts = attempts + 1,
           next_attempt_at = ?,
           last_error_code = ?
         WHERE batch_id = ?`,
      )
      .run(retry.nextAttemptAt, retry.errorCode, retry.batchId);
    return true;
  }

  markCloudSnapshotDelivered(batchIdInput: string): boolean {
    this.#assertOpen();
    const batchId = parseBatchId(batchIdInput);
    const queued = this.#database
      .prepare("SELECT payload_json FROM cloud_outbox WHERE batch_id = ?")
      .get(batchId) as SqlRow | undefined;
    if (queued === undefined) return false;
    let snapshot: IngestSnapshotV1;
    try {
      snapshot = IngestSnapshotV1Schema.parse(
        parseJson(requiredString(queued, "payload_json")),
      );
    } catch {
      return contentFreeFailure(
        "CORRUPT_STORAGE",
        "A queued cloud snapshot failed integrity validation.",
      );
    }
    const mirrored = snapshot.buckets.every((bucket) => {
      const row = this.#selectCloudMirrorByKey(bucket);
      return (
        row !== null &&
        row.receipt.batchId === snapshot.batchId &&
        row.bucket.revision === bucket.revision &&
        sameCloudMirrorValue(row, bucket, snapshot.collector)
      );
    });
    if (!mirrored) {
      throw new LocalStoreError(
        "INVALID_CLOUD_MIRROR",
        "A delivered outbox batch must be mirrored before it is removed.",
      );
    }
    return (
      changesAsNumber(
        this.#database
          .prepare("DELETE FROM cloud_outbox WHERE batch_id = ?")
          .run(batchId),
      ) === 1
    );
  }

  purgeExpiredCloudSnapshots(nowInput: string): number {
    this.#assertOpen();
    const now = parseTimestamp(
      nowInput,
      "INVALID_QUERY",
      "Cloud outbox expiry timestamp is invalid.",
    );
    return changesAsNumber(
      this.#database
        .prepare("DELETE FROM cloud_outbox WHERE expires_at <= ?")
        .run(now),
    );
  }

  clearCloudOutbox(): number {
    this.#assertOpen();
    return changesAsNumber(
      this.#database.prepare("DELETE FROM cloud_outbox").run(),
    );
  }

  getDiagnosticSummary(): LocalStoreDiagnosticSummary {
    this.#assertOpen();
    const count = (
      table:
        | "usage_daily"
        | "complete_scan_ledger"
        | "monster_state"
        | "cloud_outbox"
        | "cloud_mirror",
    ): number => {
      const row = this.#database
        .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
        .get() as SqlRow | undefined;
      return row === undefined ? 0 : safeInteger(row, "count");
    };
    const authority = this.getCollectorAuthority();
    const configRow = this.#database
      .prepare("SELECT 1 AS configured FROM local_config WHERE singleton = 1")
      .get();
    const pragmaInteger = (
      name: "foreign_keys" | "busy_timeout" | "secure_delete",
    ): number => {
      const row = this.#database.prepare(`PRAGMA ${name}`).get() as
        SqlRow | undefined;
      return row === undefined
        ? -1
        : safeInteger(row, name === "busy_timeout" ? "timeout" : name);
    };
    if (
      pragmaInteger("foreign_keys") !== 1 ||
      pragmaInteger("busy_timeout") !== 5_000 ||
      pragmaInteger("secure_delete") !== 1
    ) {
      return contentFreeFailure(
        "CORRUPT_STORAGE",
        "Local SQLite security pragmas changed unexpectedly.",
      );
    }
    return Object.freeze({
      schemaVersion: LOCAL_STORE_SCHEMA_VERSION,
      storage: this.#storage,
      journalMode: this.#journalMode,
      securityPragmas: Object.freeze({
        foreignKeys: true as const,
        busyTimeoutMs: 5_000 as const,
        secureDelete: true as const,
      }),
      counts: Object.freeze({
        dailyAggregates: count("usage_daily"),
        completeScanScopes: count("complete_scan_ledger"),
        cloudMirrorEntries: count("cloud_mirror"),
        monsterSnapshots: count("monster_state"),
        cloudOutboxEntries: count("cloud_outbox"),
      }),
      configConfigured: configRow !== undefined,
      collectorAuthority:
        authority === null
          ? Object.freeze({ configured: false as const })
          : Object.freeze({
              configured: true as const,
              kind: authority.kind,
              state: authority.state,
              adapterVersion: authority.adapterVersion,
              sourceVersion: authority.sourceVersion,
            }),
    });
  }

  exportContentBlindState(
    input: ContentBlindExportOptions,
  ): LocalContentBlindExportV1 {
    this.#assertOpen();
    const options = parseExportOptions(input);
    const dailyRows = this.#database
      .prepare(`${DAILY_SELECT}${DAILY_ORDER} LIMIT ?`)
      .all(options.maxDailyRows) as SqlRow[];
    const countRow = this.#database
      .prepare("SELECT COUNT(*) AS count FROM usage_daily")
      .get() as SqlRow | undefined;
    const dailyCount =
      countRow === undefined ? 0 : safeInteger(countRow, "count");
    const monsterRows = this.#database
      .prepare("SELECT character_id FROM monster_state ORDER BY character_id")
      .all() as SqlRow[];
    const monsterSnapshots = monsterRows.map((row) => {
      const snapshot = this.getMonsterSnapshot(
        requiredString(row, "character_id"),
      );
      if (snapshot === null) {
        return contentFreeFailure(
          "CORRUPT_STORAGE",
          "Monster state changed during a single-owner export.",
        );
      }
      return snapshot;
    });
    return Object.freeze({
      schemaVersion: "1",
      exportedAt: this.#now(),
      dailyAggregates: Object.freeze(dailyRows.map(rowToDaily)),
      dailyAggregatesTruncated: dailyCount > dailyRows.length,
      monsterSnapshots: Object.freeze(monsterSnapshots),
      config: this.getConfig(),
      collectorAuthority: this.getCollectorAuthority(),
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      if (this.#storage === "file") {
        this.#database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      }
    } finally {
      this.#database.close();
    }
  }
}

export async function openLocalStore(
  input: OpenLocalStoreOptions,
): Promise<LocalStore> {
  const options = parseOpenOptions(input);
  const storage = options.path === ":memory:" ? "memory" : "file";
  if (storage === "file" && !isAbsolute(options.path)) {
    throw new LocalStoreError(
      "INVALID_OPEN_OPTIONS",
      "A file-backed local store requires an absolute path.",
    );
  }

  let database: DatabaseSync | undefined;
  try {
    let hadContent = false;
    if (storage === "file") {
      const parent = dirname(options.path);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      if (existsSync(options.path)) {
        const metadata = lstatSync(options.path);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          throw new LocalStoreError(
            "INVALID_OPEN_OPTIONS",
            "The local store path must identify a regular private file.",
          );
        }
        hadContent = statSync(options.path).size > 0;
      }
    }

    database = new DatabaseSync(options.path, {
      allowExtension: false,
      defensive: true,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
      readBigInts: true,
      timeout: 5_000,
    });
    if (storage === "file") chmodSync(options.path, 0o600);
    configurePreMigrationPragmas(database);
    const fromVersion = getUserVersion(database);
    if (fromVersion > LOCAL_STORE_SCHEMA_VERSION) {
      return contentFreeFailure(
        "UNSUPPORTED_SCHEMA",
        "Local SQLite was created by a newer application version.",
      );
    }
    assertExpectedTables(database, fromVersion);
    if (
      storage === "file" &&
      hadContent &&
      fromVersion < LOCAL_STORE_SCHEMA_VERSION
    ) {
      await createMigrationBackup(database, options.path, fromVersion);
    }
    const journalMode = configureJournalMode(database, storage);
    if (fromVersion < LOCAL_STORE_SCHEMA_VERSION) {
      runMigrations(
        database,
        fromVersion,
        canonicalClockTimestamp(options.clock ?? (() => new Date())),
      );
    }
    assertExpectedTables(database, LOCAL_STORE_SCHEMA_VERSION);
    verifyDatabaseIntegrity(database);
    return new LocalStore(
      database,
      storage,
      journalMode,
      options.clock ?? (() => new Date()),
    );
  } catch (error: unknown) {
    if (database !== undefined) {
      try {
        database.close();
      } catch {
        // Never replace the sanitized open failure with a path-bearing close error.
      }
    }
    if (error instanceof LocalStoreError) throw error;
    return contentFreeFailure(
      "MIGRATION_FAILED",
      "Local SQLite could not be opened safely.",
    );
  }
}
