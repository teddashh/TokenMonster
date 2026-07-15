import { afterEach, describe, expect, it } from "vitest";

import { createD1AnonymousCompactionProcessor } from "../src/index.js";
import { SqliteD1Database } from "./sqlite-d1.js";

const NOW = "2026-07-15T18:30:00.000Z";
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const DEFAULT_BUCKET = "2026-06-01T00:00:00.000Z";
const MAX_PUBLIC_TOTAL = "7378697629483820645";
const openDatabases: SqliteD1Database[] = [];

type InstallationStatus = "active" | "paused" | "deleting" | "deleted";

interface TokenLedger {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning: number;
  readonly other: number;
  readonly total: number;
}

interface SeedRowOptions {
  readonly status: InstallationStatus;
  readonly quarantined: boolean;
  readonly tokens: TokenLedger;
}

interface SeedDayOptions {
  readonly offset?: number;
  readonly status?: (index: number) => InstallationStatus;
  readonly quarantined?: (index: number) => boolean;
  readonly tokens?: (index: number) => TokenLedger;
}

const DEFAULT_TOKENS: TokenLedger = Object.freeze({
  input: 10,
  output: 5,
  cacheRead: 2,
  cacheWrite: 1,
  reasoning: 3,
  other: 4,
  total: 22,
});

function database(): SqliteD1Database {
  const db = new SqliteD1Database();
  openDatabases.push(db);
  return db;
}

function processor(db: SqliteD1Database) {
  let sequence = 0;
  return createD1AnonymousCompactionProcessor(db, {
    now: () => new Date(NOW),
    createRunId: () => `compaction-run-${String(++sequence).padStart(8, "0")}`,
  });
}

function installationId(index: number): string {
  return `installation-${String(index).padStart(8, "0")}`;
}

function verifier(index: number, kind: number): Uint8Array {
  const value = new Uint8Array(32);
  value[0] = kind;
  value[1] = (index >>> 24) & 0xff;
  value[2] = (index >>> 16) & 0xff;
  value[3] = (index >>> 8) & 0xff;
  value[4] = index & 0xff;
  return value;
}

function nextDay(bucketStart: string): string {
  return new Date(Date.parse(bucketStart) + 86_400_000).toISOString();
}

function seedRow(
  db: SqliteD1Database,
  index: number,
  bucketStart: string,
  options: SeedRowOptions,
): void {
  const id = installationId(index);
  const credentialed =
    options.status === "active" || options.status === "paused";
  db.database
    .prepare(
      `INSERT INTO installations (
        installation_id, upload_token_id, upload_token_hmac,
        upload_hmac_key_id, deletion_token_id, deletion_token_hmac,
        deletion_hmac_key_id, status, consent_document_revision, created_at,
        credentials_rotated_at, paused_at, deleting_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'contribution-2026-07-15', ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      credentialed ? `upload-token-${String(index).padStart(8, "0")}` : null,
      credentialed ? verifier(index, 1) : null,
      credentialed ? "pepper-v1" : null,
      credentialed ? `delete-token-${String(index).padStart(8, "0")}` : null,
      credentialed ? verifier(index, 2) : null,
      credentialed ? "pepper-v1" : null,
      options.status,
      CREATED_AT,
      CREATED_AT,
      options.status === "paused" ? CREATED_AT : null,
      options.status === "deleting" || options.status === "deleted"
        ? CREATED_AT
        : null,
      options.status === "deleted" ? CREATED_AT : null,
    );
  db.database
    .prepare(
      `INSERT INTO collector_window_bindings (
        installation_id, bucket_start, collector_kind, adapter_version,
        source_version, created_at, expires_at
      ) VALUES (?, ?, 'tokscale', '0.1.0', '4.5.2', ?, ?)`,
    )
    .run(id, bucketStart, CREATED_AT, nextDay(bucketStart));
  db.database
    .prepare(
      `INSERT INTO usage_daily_current (
        installation_id, bucket_start, provider, model_family, tool,
        value_quality, revision, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, reasoning_tokens, other_tokens,
        total_tokens, collector_kind, adapter_version, source_version,
        row_hash, quarantine_status, quarantine_reason_code, quarantined_at,
        created_at, updated_at, expires_at
      ) VALUES (?, ?, 'openai', 'gpt-5', 'codex-cli', 'exact', 1, ?, ?, ?, ?,
        ?, ?, ?, 'tokscale', '0.1.0', '4.5.2', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      bucketStart,
      options.tokens.input,
      options.tokens.output,
      options.tokens.cacheRead,
      options.tokens.cacheWrite,
      options.tokens.reasoning,
      options.tokens.other,
      options.tokens.total,
      verifier(index, 3),
      options.quarantined ? "quarantined" : "accepted",
      options.quarantined ? "SOURCE_REJECTED" : null,
      options.quarantined ? CREATED_AT : null,
      CREATED_AT,
      CREATED_AT,
      nextDay(bucketStart),
    );
}

function seedDay(
  db: SqliteD1Database,
  bucketStart: string,
  count: number,
  options: SeedDayOptions = {},
): void {
  const ownsTransaction = !db.database.isTransaction;
  if (ownsTransaction) db.database.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < count; index += 1) {
      seedRow(db, (options.offset ?? 0) + index, bucketStart, {
        status: options.status?.(index) ?? "active",
        quarantined: options.quarantined?.(index) ?? false,
        tokens: options.tokens?.(index) ?? DEFAULT_TOKENS,
      });
    }
    if (ownsTransaction) db.database.exec("COMMIT");
  } catch (error: unknown) {
    if (ownsTransaction && db.database.isTransaction) {
      db.database.exec("ROLLBACK");
    }
    throw error;
  }
}

function count(db: SqliteD1Database, table: string): number {
  const row = db.database
    .prepare(`SELECT count(*) AS count FROM ${table}`)
    .get() as Readonly<{ count: number }>;
  return row.count;
}

function checksum(db: SqliteD1Database): string {
  const row = db.database
    .prepare("SELECT hex(checksum) AS checksum FROM compaction_runs")
    .get() as Readonly<{ checksum: string }>;
  return row.checksum;
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) db.close();
});

describe("anonymous k=20 daily compaction", () => {
  it("is idle when there is no expired complete day", async () => {
    const db = database();

    await expect(processor(db)()).resolves.toEqual({
      status: "idle",
      periodStart: null,
      inputRows: 0,
      eligibleCohortCount: 0,
      outputRows: 0,
    });
    expect(db.batchCount).toBe(0);
  });

  it("does not compact an expired row until its UTC day has closed", async () => {
    const db = database();
    const currentBucket = "2026-07-15T00:00:00.000Z";
    seedDay(db, currentBucket, 20);
    db.database
      .prepare(
        `UPDATE collector_window_bindings SET expires_at = ?;
        `,
      )
      .run("2026-07-15T01:00:00.000Z");
    db.database
      .prepare("UPDATE usage_daily_current SET expires_at = ?")
      .run("2026-07-15T01:00:00.000Z");

    await expect(processor(db)()).resolves.toMatchObject({ status: "idle" });
    expect(count(db, "usage_daily_current")).toBe(20);
    expect(count(db, "compaction_runs")).toBe(0);
  });

  it("privacy-drops k=19 and retains no token audit fields", async () => {
    const db = database();
    seedDay(db, DEFAULT_BUCKET, 19);

    await expect(processor(db)()).resolves.toEqual({
      status: "dropped",
      periodStart: "2026-06-01",
      inputRows: 19,
      eligibleCohortCount: 19,
      outputRows: 0,
    });

    expect(
      db.database
        .prepare(
          `SELECT status, input_row_count, output_row_count,
            eligible_cohort_count, k_gate_result, deleted_binding_count,
            deleted_batch_receipt_count, deleted_quarantine_event_count,
            input_tokens, output_tokens, cache_read_tokens,
            cache_write_tokens, reasoning_tokens, other_tokens, total_tokens
          FROM compaction_runs`,
        )
        .get(),
    ).toEqual({
      status: "completed",
      input_row_count: 19,
      output_row_count: 0,
      eligible_cohort_count: 19,
      k_gate_result: "dropped",
      deleted_binding_count: null,
      deleted_batch_receipt_count: null,
      deleted_quarantine_event_count: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      reasoning_tokens: null,
      other_tokens: null,
      total_tokens: null,
    });
    expect(count(db, "anonymous_rollups")).toBe(0);
    expect(count(db, "usage_daily_current")).toBe(0);
    expect(count(db, "collector_window_bindings")).toBe(0);
    expect(
      db.database.prepare("SELECT * FROM aggregate_dirty").get(),
    ).toMatchObject({ reason: "compaction", dirty_revision: 1 });
  });

  it("rolls k=20 into exactly one coarsest mapping-free row", async () => {
    const db = database();
    seedDay(db, DEFAULT_BUCKET, 20);

    await expect(processor(db)()).resolves.toEqual({
      status: "rolled-up",
      periodStart: "2026-06-01",
      inputRows: 20,
      eligibleCohortCount: 20,
      outputRows: 1,
    });

    expect(
      db.database.prepare("SELECT * FROM anonymous_rollups").get(),
    ).toMatchObject({
      period_start: "2026-06-01",
      period_end: "2026-06-02",
      scope: "all",
      provider: "other",
      model_family: "all",
      tool: "all",
      compaction_version: "day-all-v1",
      eligible_cohort_count: 20,
      input_tokens: 200,
      output_tokens: 100,
      cache_read_tokens: 40,
      cache_write_tokens: 20,
      reasoning_tokens: 60,
      other_tokens: 80,
      total_tokens: 440,
    });
    expect(
      db.database
        .prepare(
          `SELECT deleted_binding_count, deleted_batch_receipt_count,
            deleted_quarantine_event_count, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, reasoning_tokens,
            other_tokens, total_tokens FROM compaction_runs`,
        )
        .get(),
    ).toEqual({
      deleted_binding_count: 20,
      deleted_batch_receipt_count: 0,
      deleted_quarantine_event_count: 0,
      input_tokens: 200,
      output_tokens: 100,
      cache_read_tokens: 40,
      cache_write_tokens: 20,
      reasoning_tokens: 60,
      other_tokens: 80,
      total_tokens: 440,
    });
    expect(count(db, "usage_daily_current")).toBe(0);
    expect(count(db, "collector_window_bindings")).toBe(0);
  });

  it("counts paused contributors but excludes deleting contributors", async () => {
    const pausedDb = database();
    seedDay(pausedDb, DEFAULT_BUCKET, 20, {
      status: (index) => (index === 19 ? "paused" : "active"),
    });
    await expect(processor(pausedDb)()).resolves.toMatchObject({
      status: "rolled-up",
      eligibleCohortCount: 20,
    });

    const underGateDb = database();
    seedDay(underGateDb, DEFAULT_BUCKET, 20, {
      offset: 100,
      status: (index) => (index === 19 ? "deleting" : "active"),
    });
    await expect(processor(underGateDb)()).resolves.toMatchObject({
      status: "dropped",
      eligibleCohortCount: 19,
    });

    const excludedSumDb = database();
    seedDay(excludedSumDb, DEFAULT_BUCKET, 21, {
      offset: 200,
      status: (index) => (index === 20 ? "deleting" : "active"),
      tokens: (index) =>
        index === 20
          ? {
              input: 1_000,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              reasoning: 0,
              other: 0,
              total: 1_000,
            }
          : DEFAULT_TOKENS,
    });
    await expect(processor(excludedSumDb)()).resolves.toMatchObject({
      status: "rolled-up",
      eligibleCohortCount: 20,
      inputRows: 21,
    });
    expect(
      excludedSumDb.database
        .prepare("SELECT total_tokens FROM anonymous_rollups")
        .get(),
    ).toEqual({ total_tokens: 440 });
    expect(count(excludedSumDb, "usage_daily_current")).toBe(0);
  });

  it("does not let zero or quarantined rows authorize or inflate a rollup", async () => {
    const underGateDb = database();
    seedDay(underGateDb, DEFAULT_BUCKET, 21, {
      status: () => "active",
      quarantined: (index) => index === 20,
      tokens: (index) => {
        if (index === 19) {
          return {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
            other: 0,
            total: 0,
          };
        }
        return DEFAULT_TOKENS;
      },
    });
    await expect(processor(underGateDb)()).resolves.toMatchObject({
      status: "dropped",
      eligibleCohortCount: 19,
      inputRows: 21,
    });

    const excludedSumDb = database();
    seedDay(excludedSumDb, DEFAULT_BUCKET, 22, {
      offset: 100,
      quarantined: (index) => index === 21,
      tokens: (index) => {
        if (index === 20) {
          return {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
            other: 0,
            total: 0,
          };
        }
        if (index === 21) {
          return {
            input: 9_000,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
            other: 0,
            total: 9_000,
          };
        }
        return DEFAULT_TOKENS;
      },
    });
    await expect(processor(excludedSumDb)()).resolves.toMatchObject({
      status: "rolled-up",
      eligibleCohortCount: 20,
      inputRows: 22,
    });
    expect(
      excludedSumDb.database
        .prepare("SELECT total_tokens FROM anonymous_rollups")
        .get(),
    ).toEqual({ total_tokens: 440 });
  });

  it("detects a commit-time lifecycle race without deleting source truth", async () => {
    const db = database();
    seedDay(db, DEFAULT_BUCKET, 20);
    db.beforeNextBatch = () => {
      db.database
        .prepare(
          `UPDATE installations SET
            upload_token_id = NULL, upload_token_hmac = NULL,
            upload_hmac_key_id = NULL, deletion_token_id = NULL,
            deletion_token_hmac = NULL, deletion_hmac_key_id = NULL,
            status = 'deleting', deleting_at = ?
          WHERE installation_id = ?`,
        )
        .run(NOW, installationId(0));
    };

    await expect(processor(db)()).rejects.toMatchObject({
      code: "STALE_PREFLIGHT",
    });
    expect(count(db, "compaction_runs")).toBe(0);
    expect(count(db, "anonymous_rollups")).toBe(0);
    expect(count(db, "usage_daily_current")).toBe(20);
    expect(count(db, "collector_window_bindings")).toBe(20);
    expect(count(db, "aggregate_dirty")).toBe(0);
  });

  it("rolls the entire D1 batch back when anonymous output insertion fails", async () => {
    const db = database();
    seedDay(db, DEFAULT_BUCKET, 20);
    const canary = "prompt=PRIVATE-CANARY";
    db.database.exec(`CREATE TRIGGER force_rollup_failure
      BEFORE INSERT ON anonymous_rollups
      BEGIN
        SELECT RAISE(ABORT, '${canary}');
      END`);

    await expect(processor(db)()).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: expect.not.stringContaining(canary),
    });
    expect(count(db, "compaction_runs")).toBe(0);
    expect(count(db, "anonymous_rollups")).toBe(0);
    expect(count(db, "usage_daily_current")).toBe(20);
    expect(count(db, "collector_window_bindings")).toBe(20);
    expect(count(db, "aggregate_dirty")).toBe(0);
  });

  it("processes every row in a day beyond one hundred without paging gaps", async () => {
    const db = database();
    seedDay(db, DEFAULT_BUCKET, 125);

    await expect(processor(db)()).resolves.toMatchObject({
      status: "rolled-up",
      inputRows: 125,
      eligibleCohortCount: 125,
    });
    expect(
      db.database
        .prepare(
          "SELECT eligible_cohort_count, total_tokens FROM anonymous_rollups",
        )
        .get(),
    ).toEqual({ eligible_cohort_count: 125, total_tokens: 2_750 });
    expect(count(db, "usage_daily_current")).toBe(0);
    expect(count(db, "collector_window_bindings")).toBe(0);
  });

  it("closes the oldest complete day before considering the next day", async () => {
    const db = database();
    seedDay(db, "2026-05-01T00:00:00.000Z", 19);
    seedDay(db, DEFAULT_BUCKET, 20, { offset: 100 });
    const process = processor(db);

    await expect(process()).resolves.toMatchObject({
      status: "dropped",
      periodStart: "2026-05-01",
    });
    expect(
      db.database
        .prepare(
          "SELECT count(*) AS count FROM usage_daily_current WHERE bucket_start = ?",
        )
        .get(DEFAULT_BUCKET),
    ).toEqual({ count: 20 });
    await expect(process()).resolves.toMatchObject({
      status: "rolled-up",
      periodStart: "2026-06-01",
    });
    expect(count(db, "compaction_runs")).toBe(2);
    expect(count(db, "anonymous_rollups")).toBe(1);
  });

  it("capacity-drops a day above 800 rows before token aggregation", async () => {
    const db = database();
    seedDay(db, DEFAULT_BUCKET, 801, {
      tokens: () => ({
        input: Number.MAX_SAFE_INTEGER,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        other: 0,
        total: Number.MAX_SAFE_INTEGER,
      }),
    });

    await expect(processor(db)()).resolves.toEqual({
      status: "dropped",
      periodStart: "2026-06-01",
      inputRows: 801,
      eligibleCohortCount: 801,
      outputRows: 0,
    });
    expect(count(db, "anonymous_rollups")).toBe(0);
    expect(count(db, "usage_daily_current")).toBe(0);
    expect(
      db.database.prepare("SELECT total_tokens FROM compaction_runs").get(),
    ).toEqual({ total_tokens: null });
  });

  it("uses content-free stable checksums and is idempotent on retry", async () => {
    const rolledA = database();
    seedDay(rolledA, DEFAULT_BUCKET, 20);
    const processA = processor(rolledA);
    await processA();
    const rolledChecksumA = checksum(rolledA);
    const totalBeforeRetry = rolledA.database
      .prepare("SELECT total_tokens FROM anonymous_rollups")
      .get();
    await expect(processA()).resolves.toMatchObject({ status: "idle" });
    expect(count(rolledA, "compaction_runs")).toBe(1);
    expect(count(rolledA, "anonymous_rollups")).toBe(1);
    expect(
      rolledA.database
        .prepare("SELECT total_tokens FROM anonymous_rollups")
        .get(),
    ).toEqual(totalBeforeRetry);

    const rolledB = database();
    seedDay(rolledB, DEFAULT_BUCKET, 20, { offset: 1_000 });
    await processor(rolledB)();
    expect(checksum(rolledB)).toBe(rolledChecksumA);

    const droppedA = database();
    seedDay(droppedA, DEFAULT_BUCKET, 19, { offset: 2_000 });
    await processor(droppedA)();

    const droppedB = database();
    seedDay(droppedB, DEFAULT_BUCKET, 19, {
      offset: 3_000,
      tokens: () => ({
        input: 1,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        other: 0,
        total: 1,
      }),
    });
    await processor(droppedB)();
    expect(checksum(droppedB)).toBe(checksum(droppedA));
  });

  it("drops rather than overflowing the public historical capacity", async () => {
    const db = database();
    db.database.exec(`INSERT INTO anonymous_rollups (
      period_start, period_end, scope, provider, model_family, tool,
      compaction_version, eligible_cohort_count, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, reasoning_tokens, other_tokens,
      total_tokens, created_at
    ) VALUES (
      '2026-04-01', '2026-05-01', 'all', 'openai', 'gpt-5', 'codex-cli',
      'legacy-v1', 20, ${MAX_PUBLIC_TOTAL}, 0, 0, 0, 0, 0,
      ${MAX_PUBLIC_TOTAL}, '${CREATED_AT}'
    )`);
    seedDay(db, DEFAULT_BUCKET, 20, {
      tokens: () => ({
        input: 1,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        other: 0,
        total: 1,
      }),
    });

    await expect(processor(db)()).resolves.toMatchObject({
      status: "dropped",
      eligibleCohortCount: 20,
    });
    expect(count(db, "anonymous_rollups")).toBe(1);
    expect(
      db.database.prepare("SELECT k_gate_result FROM compaction_runs").get(),
    ).toEqual({ k_gate_result: "dropped" });
  });
});
