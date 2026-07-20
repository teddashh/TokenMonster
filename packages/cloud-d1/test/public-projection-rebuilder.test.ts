import { afterEach, describe, expect, it } from "vitest";

import {
  createD1PublicProjectionRebuilder,
  createD1PublicTotalsReader
} from "../src/index.js";
import { SqliteD1Database } from "./sqlite-d1.js";

const NOW = "2026-07-15T18:30:00.000Z";
const openDatabases: SqliteD1Database[] = [];

function database(): SqliteD1Database {
  const db = new SqliteD1Database();
  openDatabases.push(db);
  return db;
}

function rebuilder(db: SqliteD1Database, suffix = "0000000000000001") {
  return createD1PublicProjectionRebuilder(db, {
    now: () => new Date(NOW),
    createRevisionId: () => `revision_${suffix}`
  });
}

function seedCurrentUsage(
  db: SqliteD1Database,
  input = 1_500,
  sidecar = false
): void {
  const digest = new Uint8Array(32).fill(7);
  const collectorKind = sidecar ? "tokentracker-sidecar" : "tokscale";
  const sourceVersion = sidecar ? "0.80.0" : "4.5.2";
  db.database
    .prepare(
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
      ) VALUES (?, ?, ?, 'pepper-v1', ?, ?, 'pepper-v1', 'active',
        'contribution-2026-07-15', ?, ?)`
    )
    .run(
      "ins_AAAAAAAAAAAAAAAAAAAAAA",
      "upload_public_id_01",
      digest,
      "delete_public_id_01",
      new Uint8Array(32).fill(8),
      NOW,
      NOW
    );
  db.database
    .prepare(
      `INSERT INTO collector_window_bindings (
        installation_id, bucket_start, collector_kind, adapter_version,
        source_version, created_at, expires_at
      ) VALUES (?, '2026-07-15T00:00:00.000Z', ?, '0.1.0',
        ?, ?, '2026-08-14T00:00:00.000Z')`
    )
    .run(
      "ins_AAAAAAAAAAAAAAAAAAAAAA",
      collectorKind,
      sourceVersion,
      NOW
    );
  db.database
    .prepare(
      `INSERT INTO usage_daily_current (
        installation_id, bucket_start, provider, model_family, tool,
        value_quality, revision, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, reasoning_tokens, other_tokens,
        total_tokens, collector_kind, adapter_version, source_version,
        row_hash, quarantine_status, created_at, updated_at, expires_at
      ) VALUES (?, '2026-07-15T00:00:00.000Z', 'openai', 'gpt-5', 'codex-cli',
        'exact', 1, ?, 0, 0, 0, 0, 0, ?, ?, '0.1.0', ?,
        ?, 'accepted', ?, ?, '2026-08-14T00:00:00.000Z')`
    )
    .run(
      "ins_AAAAAAAAAAAAAAAAAAAAAA",
      input,
      input,
      collectorKind,
      sourceVersion,
      new Uint8Array(32).fill(9),
      NOW,
      NOW
    );
}

function seedHistoricalRollup(db: SqliteD1Database, total = 500): void {
  db.database
    .prepare(
      `INSERT INTO anonymous_rollups (
        period_start, period_end, scope, provider, model_family, tool,
        compaction_version, eligible_cohort_count, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, reasoning_tokens, other_tokens,
        total_tokens, created_at
      ) VALUES ('2026-05-01', '2026-06-01', 'all', 'openai', 'gpt-5',
        'codex-cli', 'v1', 20, ?, 0, 0, 0, 0, 0, ?, ?)`
    )
    .run(total, total, NOW);
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) db.close();
});

describe("authoritative public projection rebuild", () => {
  it("publishes a verified zero projection for an empty canonical database", async () => {
    const db = database();
    await expect(rebuilder(db)()).resolves.toEqual({
      allTimeTokens: "0",
      todayUtcTokens: "0",
      contributors: "0",
      generatedAt: NOW,
      dataRevision: "projection-v1/revision_0000000000000001"
    });
  });

  it("rebuilds from current accepted truth plus mapping-free rollups", async () => {
    const db = database();
    seedCurrentUsage(db);
    seedHistoricalRollup(db);
    db.database.exec(
      `INSERT INTO aggregate_dirty VALUES
        (1, '${NOW}', 'ingest', 2)`
    );

    await expect(rebuilder(db)()).resolves.toMatchObject({
      allTimeTokens: "2000",
      todayUtcTokens: "1500",
      contributors: "1"
    });
    expect(
      db.database.prepare("SELECT COUNT(*) AS count FROM aggregate_dirty").get()
    ).toEqual({ count: 0 });
  });

  it("projects accepted V2 permanent-sidecar rows without collector relabeling", async () => {
    const db = database();
    seedCurrentUsage(db, 275, true);

    await expect(rebuilder(db)()).resolves.toMatchObject({
      allTimeTokens: "275",
      todayUtcTokens: "275",
      contributors: "1"
    });
    expect(
      db.database.prepare(
        "SELECT collector_kind AS kind FROM usage_daily_current"
      ).get()
    ).toEqual({ kind: "tokentracker-sidecar" });
  });

  it("includes writes serialized immediately before its atomic batch", async () => {
    const db = database();
    seedHistoricalRollup(db);
    db.beforeNextBatch = () => seedCurrentUsage(db, 250);

    await expect(
      rebuilder(db, "0000000000000002")()
    ).resolves.toMatchObject({
      allTimeTokens: "750",
      todayUtcTokens: "250",
      contributors: "1"
    });
  });

  it("leaves dirty truth and the previous cache intact near int64 overflow", async () => {
    const db = database();
    await rebuilder(db)();
    db.database.exec(`
      INSERT INTO anonymous_rollups (
        period_start, period_end, scope, provider, model_family, tool,
        compaction_version, eligible_cohort_count, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, reasoning_tokens, other_tokens,
        total_tokens, created_at
      ) VALUES (
        '2026-05-01', '2026-06-01', 'all', 'openai', 'gpt-5', 'codex-cli',
        'v1', 20, 7378697629483820646, 0, 0, 0, 0, 0,
        7378697629483820646, '${NOW}'
      );
      INSERT INTO aggregate_dirty VALUES (1, '${NOW}', 'compaction', 1);
    `);

    await expect(
      rebuilder(db, "0000000000000003")()
    ).rejects.toMatchObject({ code: "PROJECTION_REJECTED" });
    await expect(createD1PublicTotalsReader(db)()).resolves.toMatchObject({
      allTimeTokens: "0",
      dataRevision: "projection-v1/revision_0000000000000001"
    });
    expect(
      db.database.prepare("SELECT COUNT(*) AS count FROM aggregate_dirty").get()
    ).toEqual({ count: 1 });
  });
});
