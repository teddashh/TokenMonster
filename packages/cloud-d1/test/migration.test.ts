import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const INITIAL_MIGRATION_SQL = readFileSync(
  new URL("../migrations/0001_initial.sql", import.meta.url),
  "utf8",
);
const COMPACTION_AUDIT_MIGRATION_SQL = readFileSync(
  new URL("../migrations/0002_compaction_audit.sql", import.meta.url),
  "utf8",
);
const MIGRATION_SQL = `${INITIAL_MIGRATION_SQL}\n${COMPACTION_AUDIT_MIGRATION_SQL}`;
const NOW = "2026-07-15T18:20:00Z";
const LATER = "2026-08-15T18:20:00Z";
const BUCKET = "2026-07-15T00:00:00.000Z";
const INSTALLATION_ID = "installation-0001";

const EXPECTED_TABLES = [
  "aggregate_dirty",
  "anonymous_rollups",
  "collector_window_bindings",
  "compaction_runs",
  "consent_receipts",
  "deletion_jobs",
  "ingest_batches",
  "installations",
  "mutation_guard_authorities",
  "mutation_guard_batches",
  "mutation_guard_deletions",
  "mutation_guard_installations",
  "mutation_guard_usage",
  "mutation_guards",
  "public_totals_cache",
  "quarantine_events",
  "security_rate_events",
  "share_cards",
  "usage_daily_current",
] as const;

const REQUIRED_INDEXES = Object.freeze({
  consent_receipts_expires_idx: ["expires_at", "event_id"],
  collector_window_bindings_expires_idx: ["expires_at"],
  ingest_batches_created_idx: ["created_at"],
  ingest_batches_expires_idx: ["expires_at", "installation_id", "batch_id"],
  security_rate_events_created_idx: ["created_at"],
  security_rate_events_expires_idx: ["expires_at", "event_id"],
  share_cards_expires_revoked_idx: ["expires_at", "revoked_at"],
  share_cards_revoked_idx: ["revoked_at", "share_id"],
  deletion_jobs_expires_idx: ["expires_at", "job_id"],
  deletion_jobs_replay_idx: ["replay_token_id", "expires_at"],
  installations_receipt_expires_idx: [
    "receipt_expires_at",
    "status",
    "installation_id",
  ],
  mutation_guards_expires_idx: ["expires_at"],
  usage_daily_current_bucket_quarantine_idx: [
    "bucket_start",
    "quarantine_status",
  ],
  usage_daily_current_installation_bucket_revision_idx: [
    "installation_id",
    "bucket_start",
    "revision",
  ],
  usage_daily_current_expires_idx: [
    "expires_at",
    "installation_id",
    "bucket_start",
  ],
});

type SqliteRecord = Readonly<Record<string, unknown>>;

function createDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:", {
    enableForeignKeyConstraints: true,
  });
  db.exec(MIGRATION_SQL);
  return db;
}

function records(rows: readonly unknown[]): readonly SqliteRecord[] {
  return rows as readonly SqliteRecord[];
}

function insertInstallation(
  db: DatabaseSync,
  options: Readonly<{
    uploadId?: string;
    deletionId?: string;
    uploadHmac?: Uint8Array | string;
    deletionHmac?: Uint8Array | string;
    status?: string;
  }> = {},
): void {
  db.prepare(
    `INSERT INTO installations (
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
    credentials_rotated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    INSTALLATION_ID,
    options.uploadId ?? "upload-token-0001",
    options.uploadHmac ?? new Uint8Array(32).fill(1),
    "pepper-v1",
    options.deletionId ?? "deletion-token-0001",
    options.deletionHmac ?? new Uint8Array(32).fill(2),
    "pepper-v1",
    options.status ?? "active",
    "contribution-2026-07-15",
    NOW,
    NOW,
  );
}

function insertCollectorBinding(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO collector_window_bindings (
    installation_id,
    bucket_start,
    collector_kind,
    adapter_version,
    source_version,
    created_at,
    expires_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(INSTALLATION_ID, BUCKET, "tokscale", "0.1.0", "4.5.2", NOW, LATER);
}

function insertUsage(
  db: DatabaseSync,
  ledger: Readonly<{
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
    other: number;
    total: number;
    revision?: number;
  }>,
): void {
  db.prepare(
    `INSERT INTO usage_daily_current (
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
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    INSTALLATION_ID,
    BUCKET,
    "openai",
    "gpt-5",
    "codex-cli",
    "exact",
    ledger.revision ?? 1,
    ledger.input,
    ledger.output,
    ledger.cacheRead,
    ledger.cacheWrite,
    ledger.reasoning,
    ledger.other,
    ledger.total,
    "tokscale",
    "0.1.0",
    "4.5.2",
    new Uint8Array(32).fill(3),
    "accepted",
    NOW,
    NOW,
    LATER,
  );
}

describe("0001_initial.sql", () => {
  it("applies cleanly with foreign keys enabled and creates the documented schema", () => {
    const db = createDatabase();
    try {
      const tableNames = records(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all(),
      ).map((row) => row["name"]);
      expect(tableNames).toEqual(EXPECTED_TABLES);

      const foreignKeys = records(db.prepare("PRAGMA foreign_keys").all());
      expect(foreignKeys).toEqual([{ foreign_keys: 1 }]);

      const indexNames = new Set(
        records(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'",
            )
            .all(),
        ).map((row) => row["name"]),
      );
      for (const [indexName, expectedColumns] of Object.entries(
        REQUIRED_INDEXES,
      )) {
        expect(indexNames.has(indexName)).toBe(true);
        const indexedColumns = records(
          db.prepare(`PRAGMA index_info(${indexName})`).all(),
        ).map((row) => row["name"]);
        expect(indexedColumns).toEqual(expectedColumns);
      }

      const installationColumns = records(
        db.prepare("PRAGMA table_info(installations)").all(),
      ).map((row) => row["name"]);
      expect(installationColumns).toEqual(
        expect.arrayContaining([
          "upload_token_id",
          "upload_token_hmac",
          "deletion_token_id",
          "deletion_token_hmac",
        ]),
      );

      const anonymousColumns = records(
        db.prepare("PRAGMA table_info(anonymous_rollups)").all(),
      ).map((row) => row["name"]);
      expect(anonymousColumns).not.toEqual(
        expect.arrayContaining([
          "installation_id",
          "batch_id",
          "row_hash",
          "upload_token_id",
          "deletion_token_id",
        ]),
      );
    } finally {
      db.close();
    }
  });

  it("supports a complete valid roundtrip in one SQLite transaction", () => {
    const db = createDatabase();
    try {
      db.exec("BEGIN IMMEDIATE");
      insertInstallation(db);
      db.prepare(
        `INSERT INTO consent_receipts (
        event_id, installation_id, purpose, document_revision, granted,
        occurred_at, recorded_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "consent-event-0001",
        INSTALLATION_ID,
        "contribution",
        "contribution-2026-07-15",
        1,
        NOW,
        NOW,
        LATER,
      );
      insertCollectorBinding(db);
      db.prepare(
        `INSERT INTO ingest_batches (
        installation_id, batch_id, payload_hash, status, bucket_count,
        applied_bucket_count, stale_bucket_count, idempotent_bucket_count,
        quarantined_bucket_count, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        INSTALLATION_ID,
        "batch-accepted-0001",
        new Uint8Array(32).fill(4),
        "accepted",
        1,
        1,
        0,
        0,
        0,
        NOW,
        "2026-07-22T18:20:00Z",
      );
      db.prepare(
        `INSERT INTO ingest_batches (
        installation_id, batch_id, payload_hash, status, bucket_count,
        applied_bucket_count, stale_bucket_count, idempotent_bucket_count,
        quarantined_bucket_count, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        INSTALLATION_ID,
        "batch-quarantine-01",
        new Uint8Array(32).fill(5),
        "quarantined",
        1,
        0,
        0,
        0,
        1,
        NOW,
        "2026-07-22T18:20:00Z",
      );
      insertUsage(db, {
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        reasoning: 3,
        other: 4,
        total: 22,
      });
      db.prepare(
        `INSERT INTO anonymous_rollups (
        period_start, period_end, scope, provider, model_family, tool,
        compaction_version, eligible_cohort_count, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, reasoning_tokens, other_tokens,
        total_tokens, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "2026-06-01",
        "2026-07-01",
        "all",
        "other",
        "other",
        "other",
        "1",
        20,
        100,
        50,
        20,
        10,
        25,
        5,
        185,
        NOW,
      );
      db.prepare(
        `INSERT INTO compaction_runs (
        run_id, period_start, period_end, compaction_version, status,
        input_row_count, output_row_count, eligible_cohort_count,
        k_gate_result, checksum, started_at, finished_at,
        deleted_binding_count, deleted_batch_receipt_count,
        deleted_quarantine_event_count, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, reasoning_tokens, other_tokens,
        total_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "compaction-run-0001",
        "2026-06-01",
        "2026-07-01",
        "1",
        "completed",
        20,
        1,
        20,
        "rolled_up",
        new Uint8Array(32).fill(6),
        NOW,
        NOW,
        0,
        0,
        0,
        100,
        50,
        20,
        10,
        25,
        5,
        185,
      );
      db.prepare(
        `INSERT INTO public_totals_cache (
        scope, day_or_all, all_time_tokens, today_utc_tokens, contributors,
        generated_at, data_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("global", "all", "207", "22", "1", NOW, "2026-07-15T18:20:00Z/1");
      db.prepare(
        `INSERT INTO share_cards (
        share_id, installation_id, character_asset_id, trait_ids_json,
        reason_codes_json, coarse_time_window, token_band, token_total,
        locale, theme, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "0123456789abcdef0123456789abcdef",
        INSTALLATION_ID,
        "tokenmonster.placeholder.v1",
        '["cli-native","cache-savvy"]',
        '["tool-dominance"]',
        "28-days",
        "small",
        "22",
        "zh-TW",
        "dark",
        NOW,
        LATER,
      );
      db.prepare(
        `INSERT INTO security_rate_events (
        event_id, route_class, reason_code, rate_key_hmac, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        "security-event-001",
        "ingest",
        "BURST_LIMIT",
        new Uint8Array(32).fill(7),
        NOW,
        LATER,
      );
      db.prepare(
        `INSERT INTO quarantine_events (
        event_id, installation_id, batch_id, bucket_index, reason_code,
        decision, created_at, decided_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "quarantine-event-1",
        INSTALLATION_ID,
        "batch-quarantine-01",
        0,
        "FUTURE_BUCKET",
        "quarantined",
        NOW,
        NOW,
        LATER,
      );
      db.prepare(
        `INSERT INTO deletion_jobs (
        job_id, installation_id, idempotency_key, status_token_id,
        status_token_hmac, status_hmac_key_id, replay_token_id,
        replay_token_hmac, replay_hmac_key_id, state,
        anonymous_historical_totals_retained, requested_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "deletion-job-0001",
        INSTALLATION_ID,
        "deletion-request-0001",
        "delete-status-0001",
        new Uint8Array(32).fill(8),
        "pepper-v1",
        "delete-replay-0001",
        new Uint8Array(32).fill(9),
        "pepper-v1",
        "queued",
        1,
        NOW,
        LATER,
      );
      db.prepare(
        `INSERT INTO aggregate_dirty (
        singleton_key, dirty_since, reason, dirty_revision
      ) VALUES (?, ?, ?, ?)`,
      ).run(1, NOW, "ingest", 1);
      db.exec("COMMIT");

      const usage = db
        .prepare(
          "SELECT total_tokens, reasoning_tokens FROM usage_daily_current",
        )
        .get() as SqliteRecord;
      expect(usage).toEqual({ total_tokens: 22, reasoning_tokens: 3 });
      const projection = db
        .prepare(
          "SELECT all_time_tokens, today_utc_tokens, contributors FROM public_totals_cache",
        )
        .get() as SqliteRecord;
      expect(projection).toEqual({
        all_time_tokens: "207",
        today_utc_tokens: "22",
        contributors: "1",
      });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
    } finally {
      if (db.isTransaction) db.exec("ROLLBACK");
      db.close();
    }
  });

  it.each([
    {
      name: "a negative main token component",
      ledger: {
        input: -1,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        reasoning: 3,
        other: 4,
        total: 11,
      },
    },
    {
      name: "reasoning outside the output subset",
      ledger: {
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        reasoning: 6,
        other: 4,
        total: 22,
      },
    },
    {
      name: "a total that double-counts reasoning",
      ledger: {
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        reasoning: 3,
        other: 4,
        total: 25,
      },
    },
    {
      name: "a revision above the JavaScript safe-integer boundary",
      ledger: {
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        reasoning: 3,
        other: 4,
        total: 22,
        revision: 9_007_199_254_740_992,
      },
    },
  ])("rejects $name", ({ ledger }) => {
    const db = createDatabase();
    try {
      insertInstallation(db);
      insertCollectorBinding(db);
      expect(() => insertUsage(db, ledger)).toThrow(/constraint failed/i);
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM usage_daily_current").get(),
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("rejects malformed or non-separate credential verifiers", () => {
    const shortVerifierDb = createDatabase();
    try {
      expect(() =>
        insertInstallation(shortVerifierDb, {
          uploadHmac: new Uint8Array(31).fill(1),
        }),
      ).toThrow(/constraint failed/i);
    } finally {
      shortVerifierDb.close();
    }

    const sharedCredentialDb = createDatabase();
    try {
      expect(() =>
        insertInstallation(sharedCredentialDb, {
          deletionId: "upload-token-0001",
        }),
      ).toThrow(/constraint failed/i);
    } finally {
      sharedCredentialDb.close();
    }

    const plaintextVerifierDb = createDatabase();
    try {
      expect(() =>
        insertInstallation(plaintextVerifierDb, {
          uploadHmac: "not-a-binary-hmac-verifier-00000",
        }),
      ).toThrow(/cannot store TEXT value in BLOB column/i);
    } finally {
      plaintextVerifierDb.close();
    }
  });

  it("allows credentials to be atomically revoked only with deleting state", () => {
    const db = createDatabase();
    try {
      insertInstallation(db);
      db.prepare(
        `UPDATE installations SET
        upload_token_id = NULL,
        upload_token_hmac = NULL,
        upload_hmac_key_id = NULL,
        deletion_token_id = NULL,
        deletion_token_hmac = NULL,
        deletion_hmac_key_id = NULL,
        status = 'deleting',
        deleting_at = ?,
        receipt_expires_at = ?
      WHERE installation_id = ?`,
      ).run(NOW, LATER, INSTALLATION_ID);
      expect(
        db
          .prepare(
            `SELECT status, upload_token_id, deletion_token_id
          FROM installations`,
          )
          .get(),
      ).toEqual({
        status: "deleting",
        upload_token_id: null,
        deletion_token_id: null,
      });
      expect(() =>
        db.prepare("UPDATE installations SET status = 'active'").run(),
      ).toThrow(/constraint failed/i);
    } finally {
      db.close();
    }
  });

  it("rejects unknown lifecycle and projection statuses", () => {
    const db = createDatabase();
    try {
      expect(() => insertInstallation(db, { status: "enabled" })).toThrow(
        /constraint failed/i,
      );
      expect(() =>
        db
          .prepare(
            `INSERT INTO public_totals_cache (
          scope, day_or_all, all_time_tokens, today_utc_tokens, contributors,
          generated_at, data_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run("global", "today", "10", "1", "1", NOW, "revision-1"),
      ).toThrow(/constraint failed/i);
    } finally {
      db.close();
    }
  });

  it("rejects non-canonical public totals and anonymous cohorts below k=20", () => {
    const db = createDatabase();
    try {
      expect(() =>
        db
          .prepare(
            `INSERT INTO public_totals_cache (
          scope, day_or_all, all_time_tokens, today_utc_tokens, contributors,
          generated_at, data_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run("global", "all", "010", "1", "1", NOW, "revision-1"),
      ).toThrow(/constraint failed/i);

      expect(() =>
        db
          .prepare(
            `INSERT INTO anonymous_rollups (
          period_start, period_end, scope, provider, model_family, tool,
          compaction_version, eligible_cohort_count, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, reasoning_tokens, other_tokens,
          total_tokens, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "2026-06-01",
            "2026-07-01",
            "all",
            "other",
            "other",
            "other",
            "1",
            19,
            1,
            1,
            0,
            0,
            0,
            0,
            2,
            NOW,
          ),
      ).toThrow(/constraint failed/i);
    } finally {
      db.close();
    }
  });

  it("contains no forbidden cloud columns and creates no seed rows", () => {
    const db = createDatabase();
    try {
      const forbiddenColumn =
        /(?:^|_)(?:prompt|response|message|conversation|source_code|filename|file_path|project_path|workspace|repository|email|account|api_key|oauth|cookie|provider_credential|raw_payload|raw_json)(?:_|$)/u;
      for (const table of EXPECTED_TABLES) {
        const columns = records(
          db.prepare(`PRAGMA table_info(${table})`).all(),
        ).map((row) => String(row["name"]));
        expect(
          columns.filter((column) => forbiddenColumn.test(column)),
        ).toEqual([]);
        expect(
          db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
        ).toEqual({ count: 0 });
      }
      expect(MIGRATION_SQL).not.toMatch(/\bINSERT\s+INTO\b/iu);
    } finally {
      db.close();
    }
  });
});

describe("0002_compaction_audit.sql", () => {
  it("rejects private audit data for failed, under-k, or dropped runs", () => {
    const db = createDatabase();
    const checksum = new Uint8Array(32).fill(9);
    try {
      expect(() =>
        db
          .prepare(
            `INSERT INTO compaction_runs (
          run_id, period_start, period_end, compaction_version, status,
          input_row_count, output_row_count, eligible_cohort_count,
          k_gate_result, checksum, started_at, finished_at,
          deleted_binding_count, deleted_batch_receipt_count,
          deleted_quarantine_event_count, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, reasoning_tokens, other_tokens,
          total_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "failed-under-k-0001",
            "2026-05-01",
            "2026-06-01",
            "legacy-v2",
            "failed",
            19,
            1,
            19,
            "rolled_up",
            checksum,
            NOW,
            NOW,
            19,
            0,
            0,
            1,
            1,
            0,
            0,
            0,
            0,
            2,
          ),
      ).toThrow(/TM_COMPACTION_PRIVATE_SHAPE/);

      expect(() =>
        db
          .prepare(
            `INSERT INTO compaction_runs (
          run_id, period_start, period_end, compaction_version, status,
          input_row_count, output_row_count, eligible_cohort_count,
          k_gate_result, checksum, started_at, finished_at, input_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "dropped-with-audit-0001",
            "2026-05-01",
            "2026-06-01",
            "legacy-v2",
            "completed",
            19,
            0,
            19,
            "dropped",
            checksum,
            NOW,
            NOW,
            1,
          ),
      ).toThrow(/TM_COMPACTION_PRIVATE_SHAPE/);

      expect(() =>
        db
          .prepare(
            `INSERT INTO compaction_runs (
          run_id, period_start, period_end, compaction_version, status,
          input_row_count, output_row_count, eligible_cohort_count,
          k_gate_result, checksum, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "rolled-without-audit-01",
            "2026-05-01",
            "2026-06-01",
            "legacy-v2",
            "completed",
            20,
            1,
            20,
            "rolled_up",
            checksum,
            NOW,
            NOW,
          ),
      ).toThrow(/TM_COMPACTION_ROLLUP_AUDIT/);

      expect(
        db.prepare("SELECT count(*) AS count FROM compaction_runs").get(),
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("makes day-all runs and rollups immutable and enforces coarsest shape", () => {
    const db = createDatabase();
    const checksum = new Uint8Array(32).fill(10);
    try {
      db.prepare(
        `INSERT INTO compaction_runs (
        run_id, period_start, period_end, compaction_version, status,
        input_row_count, output_row_count, eligible_cohort_count,
        k_gate_result, checksum, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "day-drop-run-000001",
        "2026-07-15",
        "2026-07-16",
        "day-all-v1",
        "completed",
        19,
        0,
        19,
        "dropped",
        checksum,
        NOW,
        NOW,
      );
      db.prepare(
        `INSERT INTO anonymous_rollups (
        period_start, period_end, scope, provider, model_family, tool,
        compaction_version, eligible_cohort_count, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, reasoning_tokens, other_tokens,
        total_tokens, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "2026-07-15",
        "2026-07-16",
        "all",
        "other",
        "all",
        "all",
        "day-all-v1",
        20,
        10,
        5,
        2,
        1,
        3,
        4,
        22,
        NOW,
      );

      expect(() =>
        db
          .prepare(
            "UPDATE compaction_runs SET compaction_version = 'legacy-v3'",
          )
          .run(),
      ).toThrow(/TM_COMPACTION_IMMUTABLE/);
      expect(() =>
        db.prepare("UPDATE anonymous_rollups SET provider = 'openai'").run(),
      ).toThrow(/TM_COMPACTION_IMMUTABLE/);
      expect(() =>
        db
          .prepare(
            `UPDATE anonymous_rollups SET
            input_tokens = input_tokens + 1,
            total_tokens = total_tokens + 1`,
          )
          .run(),
      ).toThrow(/TM_COMPACTION_IMMUTABLE/);
      expect(() => db.prepare("DELETE FROM anonymous_rollups").run()).toThrow(
        /TM_COMPACTION_IMMUTABLE/,
      );

      expect(() =>
        db
          .prepare(
            `INSERT INTO anonymous_rollups (
          period_start, period_end, scope, provider, model_family, tool,
          compaction_version, eligible_cohort_count, input_tokens,
          output_tokens, cache_read_tokens, cache_write_tokens,
          reasoning_tokens, other_tokens, total_tokens, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "2026-07-16",
            "2026-07-17",
            "all",
            "openai",
            "all",
            "all",
            "day-all-v1",
            20,
            1,
            0,
            0,
            0,
            0,
            0,
            1,
            NOW,
          ),
      ).toThrow(/TM_COMPACTION_DAY_SHAPE/);
      expect(() =>
        db
          .prepare(
            `INSERT INTO compaction_runs (
          run_id, period_start, period_end, compaction_version, status,
          input_row_count, output_row_count, eligible_cohort_count,
          k_gate_result, checksum, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "bad-day-run-000001",
            "2026-07-16",
            "2026-07-18",
            "day-all-v1",
            "completed",
            19,
            0,
            19,
            "dropped",
            checksum,
            NOW,
            NOW,
          ),
      ).toThrow(/TM_COMPACTION_DAY_SHAPE/);
    } finally {
      db.close();
    }
  });

  it.each([
    {
      name: "an invalid month",
      periodStart: "2026-13-01",
      periodEnd: "2026-13-02",
    },
    {
      name: "a normalized invalid day",
      periodStart: "2026-02-30",
      periodEnd: "2026-03-03",
    },
  ])(
    "rejects $name in day-all runs and rollups",
    ({ periodStart, periodEnd }) => {
      const db = createDatabase();
      try {
        expect(() =>
          db
            .prepare(
              `INSERT INTO compaction_runs (
          run_id, period_start, period_end, compaction_version, status,
          input_row_count, output_row_count, eligible_cohort_count,
          k_gate_result, checksum, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              "invalid-day-run-00001",
              periodStart,
              periodEnd,
              "day-all-v1",
              "completed",
              19,
              0,
              19,
              "dropped",
              new Uint8Array(32).fill(13),
              NOW,
              NOW,
            ),
        ).toThrow(/TM_COMPACTION_DAY_SHAPE/);
        expect(() =>
          db
            .prepare(
              `INSERT INTO anonymous_rollups (
          period_start, period_end, scope, provider, model_family, tool,
          compaction_version, eligible_cohort_count, input_tokens,
          output_tokens, cache_read_tokens, cache_write_tokens,
          reasoning_tokens, other_tokens, total_tokens, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              periodStart,
              periodEnd,
              "all",
              "other",
              "all",
              "all",
              "day-all-v1",
              20,
              1,
              0,
              0,
              0,
              0,
              0,
              1,
              NOW,
            ),
        ).toThrow(/TM_COMPACTION_DAY_SHAPE/);
        expect(
          db.prepare("SELECT count(*) AS count FROM compaction_runs").get(),
        ).toEqual({ count: 0 });
        expect(
          db.prepare("SELECT count(*) AS count FROM anonymous_rollups").get(),
        ).toEqual({ count: 0 });
      } finally {
        db.close();
      }
    },
  );

  it("closes collector bindings and usage inserts after a completed day", () => {
    const db = createDatabase();
    try {
      db.prepare(
        `INSERT INTO compaction_runs (
        run_id, period_start, period_end, compaction_version, status,
        input_row_count, output_row_count, eligible_cohort_count,
        k_gate_result, checksum, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "closed-day-run-00001",
        "2026-07-15",
        "2026-07-16",
        "day-all-v1",
        "completed",
        19,
        0,
        19,
        "dropped",
        new Uint8Array(32).fill(11),
        NOW,
        NOW,
      );
      insertInstallation(db);

      expect(() => db.prepare("DELETE FROM compaction_runs").run()).toThrow(
        /TM_COMPACTION_IMMUTABLE/,
      );
      expect(
        db.prepare("SELECT count(*) AS count FROM compaction_runs").get(),
      ).toEqual({ count: 1 });
      expect(() => insertCollectorBinding(db)).toThrow(
        /TM_COMPACTED_DAY_CLOSED/,
      );
      expect(() =>
        insertUsage(db, {
          input: 10,
          output: 5,
          cacheRead: 2,
          cacheWrite: 1,
          reasoning: 3,
          other: 4,
          total: 22,
        }),
      ).toThrow(/TM_COMPACTED_DAY_CLOSED/);
      expect(
        db
          .prepare("SELECT count(*) AS count FROM collector_window_bindings")
          .get(),
      ).toEqual({ count: 0 });
      expect(
        db.prepare("SELECT count(*) AS count FROM usage_daily_current").get(),
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("upgrades legacy 0001 rows without fabricating audit evidence", () => {
    const db = new DatabaseSync(":memory:", {
      enableForeignKeyConstraints: true,
    });
    try {
      db.exec(INITIAL_MIGRATION_SQL);
      db.prepare(
        `INSERT INTO compaction_runs (
        run_id, period_start, period_end, compaction_version, status,
        input_row_count, output_row_count, eligible_cohort_count,
        k_gate_result, checksum, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "legacy-rollup-run-001",
        "2026-05-01",
        "2026-06-01",
        "legacy-v1",
        "completed",
        19,
        1,
        19,
        "rolled_up",
        new Uint8Array(32).fill(12),
        NOW,
        NOW,
      );

      db.exec(COMPACTION_AUDIT_MIGRATION_SQL);

      expect(
        db
          .prepare(
            `SELECT
          deleted_binding_count, deleted_batch_receipt_count,
          deleted_quarantine_event_count, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, reasoning_tokens,
          other_tokens, total_tokens
        FROM compaction_runs`,
          )
          .get(),
      ).toEqual({
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
      expect(
        db.prepare("SELECT count(*) AS count FROM compaction_runs").get(),
      ).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });
});
