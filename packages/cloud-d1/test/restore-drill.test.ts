import { createHash } from "node:crypto";

import type {
  CredentialService,
  SuppressionLedgerEntry,
  SuppressionLedgerPort
} from "@tokenmonster/api-domain";
import { afterEach, describe, expect, it } from "vitest";

import {
  checksumD1RestoreProjection,
  createD1SuppressionAwareRestoreDrill,
  D1RestoreDrillError,
  type D1RestoreDrillEvidence,
  type D1RestoreDrillExpectations
} from "../src/index.js";
import { SqliteD1Database } from "./sqlite-d1.js";

const NOW = "2026-07-15T18:30:00.000Z";
const RECORDED_AT = "2026-07-15T18:00:00.000Z";
const EXPIRES_AT = "2026-08-14T18:30:00.000Z";
const BUCKET = "2026-07-15T00:00:00.000Z";
const SUPPRESSED_INSTALLATION = `ins_${"A".repeat(22)}`;
const RETAINED_INSTALLATION = `ins_${"B".repeat(22)}`;
const RESTORED_JOB_INSTALLATION = `ins_${"C".repeat(22)}`;

function base64Url(byte: number): string {
  const bytes = new Uint8Array(32).fill(byte);
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

const SUPPRESSED_MARKER = base64Url(91);
const RETAINED_MARKER = base64Url(92);
const RESTORED_JOB_MARKER = base64Url(93);
const RESTORED_USAGE_GUARD = "restored-usage-guard-0001";
const RESTORED_RETAINED_GUARD = "restored-retained-guard-0001";
const RESTORED_DELETION_GUARD = "restored-delete-guard-0001";

function projectionChecksum(
  allTimeTokenCount: string,
  todayUtcTokenCount: string,
  contributorCount: string
): string {
  return createHash("sha256")
    .update(
      [
        "tokenmonster-restore-projection-v1",
        allTimeTokenCount,
        todayUtcTokenCount,
        contributorCount
      ].join("\u0000")
    )
    .digest("hex");
}

function evidenceChecksum(input: D1RestoreDrillEvidence): string {
  return createHash("sha256")
    .update(
      [
        "tokenmonster-restore-evidence-v1",
        input["activeSuppressionCount"],
        input["restoredInstallationCount"],
        input["purgedInstallationCount"],
        input["attributableResidueCount"],
        input["credentialResidueCount"],
        input["shareResidueCount"],
        input["allTimeTokenCount"],
        input["todayUtcTokenCount"],
        input["contributorCount"],
        input["projectionChecksum"]
      ].join("\u0000")
    )
    .digest("hex");
}

class MarkerDeriver
  implements Pick<CredentialService, "deriveSuppressionMarker">
{
  async deriveSuppressionMarker(installationId: string): Promise<string> {
    if (installationId === SUPPRESSED_INSTALLATION) return SUPPRESSED_MARKER;
    if (installationId === RETAINED_INSTALLATION) return RETAINED_MARKER;
    if (installationId === RESTORED_JOB_INSTALLATION) {
      return RESTORED_JOB_MARKER;
    }
    throw new Error(`private:${installationId}`);
  }
}

class FixtureSuppressionLedger
  implements Pick<SuppressionLedgerPort, "listActive">
{
  failure: Error | null = null;
  calls = 0;
  afterFirstEntries: readonly SuppressionLedgerEntry[] | null = null;
  entries: readonly SuppressionLedgerEntry[] = Object.freeze([
    Object.freeze({
      suppressionMarker: SUPPRESSED_MARKER,
      recordedAt: RECORDED_AT,
      expiresAt: EXPIRES_AT
    }),
    Object.freeze({
      suppressionMarker: RESTORED_JOB_MARKER,
      recordedAt: RECORDED_AT,
      expiresAt: EXPIRES_AT
    })
  ]);

  async listActive(): Promise<readonly SuppressionLedgerEntry[]> {
    this.calls += 1;
    if (this.failure !== null) throw this.failure;
    return this.calls > 1 && this.afterFirstEntries !== null
      ? this.afterFirstEntries
      : this.entries;
  }
}

const openDatabases: SqliteD1Database[] = [];

function database(): SqliteD1Database {
  const db = new SqliteD1Database();
  openDatabases.push(db);
  return db;
}

function seedInstallation(
  db: SqliteD1Database,
  input: Readonly<{
    installationId: string;
    suffix: string;
    seed: number;
    total: number;
    includeRestoredPrivateArtifacts: boolean;
  }>
): void {
  const uploadId = `upload_public_${input.suffix}`;
  const deletionId = `delete_public_${input.suffix}`;
  db.database
    .prepare(
      `INSERT INTO installations (
        installation_id, upload_token_id, upload_token_hmac,
        upload_hmac_key_id, deletion_token_id, deletion_token_hmac,
        deletion_hmac_key_id, status, consent_document_revision, created_at,
        credentials_rotated_at
      ) VALUES (?, ?, ?, 'pepper-v1', ?, ?, 'pepper-v1', 'active',
        'contribution-2026-07-15', ?, ?)`
    )
    .run(
      input.installationId,
      uploadId,
      new Uint8Array(32).fill(input.seed),
      deletionId,
      new Uint8Array(32).fill(input.seed + 10),
      NOW,
      NOW
    );
  db.database
    .prepare(
      `INSERT INTO consent_receipts (
        event_id, installation_id, purpose, document_revision, granted,
        occurred_at, recorded_at, expires_at
      ) VALUES (?, ?, 'contribution', 'contribution-2026-07-15', 1, ?, ?, ?)`
    )
    .run(`consent-event-${input.suffix}`, input.installationId, NOW, NOW, EXPIRES_AT);
  db.database
    .prepare(
      `INSERT INTO collector_window_bindings (
        installation_id, bucket_start, collector_kind, adapter_version,
        source_version, created_at, expires_at
      ) VALUES (?, ?, 'tokscale', '0.1.0', '4.5.2', ?, ?)`
    )
    .run(input.installationId, BUCKET, NOW, EXPIRES_AT);
  db.database
    .prepare(
      `INSERT INTO usage_daily_current (
        installation_id, bucket_start, provider, model_family, tool,
        value_quality, revision, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, reasoning_tokens, other_tokens,
        total_tokens, collector_kind, adapter_version, source_version,
        row_hash, quarantine_status, created_at, updated_at, expires_at
      ) VALUES (?, ?, 'openai', 'gpt-5', 'codex-cli', 'exact', 1,
        ?, 0, 0, 0, 0, 0, ?, 'tokscale', '0.1.0', '4.5.2', ?, 'accepted',
        ?, ?, ?)`
    )
    .run(
      input.installationId,
      BUCKET,
      input.total,
      input.total,
      new Uint8Array(32).fill(input.seed + 20),
      NOW,
      NOW,
      EXPIRES_AT
    );

  if (!input.includeRestoredPrivateArtifacts) return;
  db.database
    .prepare(
      `INSERT INTO ingest_batches (
        installation_id, batch_id, payload_hash, status, bucket_count,
        applied_bucket_count, stale_bucket_count, idempotent_bucket_count,
        quarantined_bucket_count, created_at, expires_at
      ) VALUES (?, ?, ?, 'quarantined', 1, 0, 0, 0, 1, ?, ?)`
    )
    .run(
      input.installationId,
      `restore-batch-${input.suffix}`,
      new Uint8Array(32).fill(input.seed + 30),
      NOW,
      EXPIRES_AT
    );
  db.database
    .prepare(
      `INSERT INTO quarantine_events (
        event_id, installation_id, batch_id, bucket_index, reason_code,
        decision, created_at, decided_at, expires_at
      ) VALUES (?, ?, ?, 0, 'fixture', 'quarantined', ?, ?, ?)`
    )
    .run(
      `quarantine-event-${input.suffix}`,
      input.installationId,
      `restore-batch-${input.suffix}`,
      NOW,
      NOW,
      EXPIRES_AT
    );
  db.database
    .prepare(
      `INSERT INTO share_cards (
        share_id, installation_id, character_asset_id, trait_ids_json,
        reason_codes_json, coarse_time_window, token_band, token_total,
        locale, theme, created_at, expires_at
      ) VALUES (?, ?, 'monster.restore', '["calm","steady"]',
        '["restore-fixture"]', 'day', 'small', ?, 'en', 'dark', ?, ?)`
    )
    .run(
      `share-${input.suffix}-${"s".repeat(32)}`,
      input.installationId,
      String(input.total),
      NOW,
      EXPIRES_AT
    );
}

function seedRestoredDeletionJob(
  db: SqliteD1Database,
  state: "queued" | "running"
): void {
  db.database
    .prepare(
      `INSERT INTO deletion_jobs (
        job_id, installation_id, idempotency_key,
        status_token_id, status_token_hmac, status_hmac_key_id,
        replay_token_id, replay_token_hmac, replay_hmac_key_id,
        state, anonymous_historical_totals_retained, requested_at, started_at,
        finished_at, expires_at, failure_code
      ) VALUES (?, ?, ?, ?, ?, 'status-v1', ?, ?, 'pepper-v1', ?, 1, ?, ?,
        NULL, ?, NULL)`
    )
    .run(
      `restored-job-${state}-0001`,
      RESTORED_JOB_INSTALLATION,
      `restored-delete-${state}-0001`,
      `status_${state}_00000001`,
      new Uint8Array(32).fill(71),
      `replay_${state}_00000001`,
      new Uint8Array(32).fill(72),
      state,
      RECORDED_AT,
      state === "running" ? NOW : null,
      EXPIRES_AT
    );
}

function seedRestoredMutationGuardShadows(db: SqliteD1Database): void {
  db.database
    .prepare(
      `INSERT INTO mutation_guards (request_id, operation, expires_at)
       VALUES (?, 'ingest', ?)`
    )
    .run(RESTORED_USAGE_GUARD, EXPIRES_AT);
  db.database
    .prepare(
      `INSERT INTO mutation_guard_installations (
        request_id, installation_id, expected_exists, expected_status,
        expected_consent_document_revision, expected_upload_token_id,
        expected_upload_token_hmac, expected_upload_hmac_key_id,
        expected_deletion_token_id, expected_deletion_token_hmac,
        expected_deletion_hmac_key_id
      ) SELECT ?, installation_id, 1, status, consent_document_revision,
        upload_token_id, upload_token_hmac, upload_hmac_key_id,
        deletion_token_id, deletion_token_hmac, deletion_hmac_key_id
      FROM installations WHERE installation_id = ?`
    )
    .run(RESTORED_USAGE_GUARD, SUPPRESSED_INSTALLATION);
  db.database
    .prepare(
      `INSERT INTO mutation_guard_batches (
        request_id, installation_id, batch_id, expected_exists,
        expected_payload_hash, expected_applied_bucket_count,
        expected_stale_bucket_count, expected_idempotent_bucket_count,
        expected_quarantined_bucket_count, expected_created_at
      ) SELECT ?, installation_id, batch_id, 1, payload_hash,
        applied_bucket_count, stale_bucket_count, idempotent_bucket_count,
        quarantined_bucket_count, created_at
      FROM ingest_batches WHERE installation_id = ?`
    )
    .run(RESTORED_USAGE_GUARD, SUPPRESSED_INSTALLATION);
  db.database
    .prepare(
      `INSERT INTO mutation_guard_authorities (
        request_id, installation_id, bucket_start, expected_exists,
        expected_collector_kind, expected_adapter_version,
        expected_source_version
      ) SELECT ?, installation_id, bucket_start, 1, collector_kind,
        adapter_version, source_version
      FROM collector_window_bindings WHERE installation_id = ?`
    )
    .run(RESTORED_USAGE_GUARD, SUPPRESSED_INSTALLATION);
  db.database
    .prepare(
      `INSERT INTO mutation_guard_usage (
        request_id, installation_id, bucket_start, provider, model_family,
        tool, expected_exists, expected_revision, expected_row_hash
      ) SELECT ?, installation_id, bucket_start, provider, model_family,
        tool, 1, revision, row_hash
      FROM usage_daily_current WHERE installation_id = ?`
    )
    .run(RESTORED_USAGE_GUARD, SUPPRESSED_INSTALLATION);

  // Even a guard shadow for a retained installation is abandoned after an
  // offline restore and must not survive into the reopened database.
  db.database
    .prepare(
      `INSERT INTO mutation_guards (request_id, operation, expires_at)
       VALUES (?, 'ingest', ?)`
    )
    .run(RESTORED_RETAINED_GUARD, EXPIRES_AT);
  db.database
    .prepare(
      `INSERT INTO mutation_guard_installations (
        request_id, installation_id, expected_exists, expected_status,
        expected_consent_document_revision, expected_upload_token_id,
        expected_upload_token_hmac, expected_upload_hmac_key_id,
        expected_deletion_token_id, expected_deletion_token_hmac,
        expected_deletion_hmac_key_id
      ) SELECT ?, installation_id, 1, status, consent_document_revision,
        upload_token_id, upload_token_hmac, upload_hmac_key_id,
        deletion_token_id, deletion_token_hmac, deletion_hmac_key_id
      FROM installations WHERE installation_id = ?`
    )
    .run(RESTORED_RETAINED_GUARD, RETAINED_INSTALLATION);

  db.database
    .prepare(
      `INSERT INTO mutation_guards (request_id, operation, expires_at)
       VALUES (?, 'complete-delete', ?)`
    )
    .run(RESTORED_DELETION_GUARD, EXPIRES_AT);
  db.database
    .prepare(
      `INSERT INTO mutation_guard_deletions (
        request_id, installation_id, idempotency_key, expected_exists,
        expected_job_id, expected_state, expected_status_token_id,
        expected_status_token_hmac, expected_status_hmac_key_id,
        expected_replay_token_id, expected_replay_token_hmac,
        expected_replay_hmac_key_id,
        expected_anonymous_historical_totals_retained,
        expected_requested_at, expected_finished_at, expected_expires_at
      ) SELECT ?, installation_id, idempotency_key, 1, job_id, state,
        status_token_id, status_token_hmac, status_hmac_key_id,
        replay_token_id, replay_token_hmac, replay_hmac_key_id,
        anonymous_historical_totals_retained, requested_at, finished_at,
        expires_at
      FROM deletion_jobs WHERE installation_id = ?`
    )
    .run(RESTORED_DELETION_GUARD, RESTORED_JOB_INSTALLATION);
}

function seedRestoredFixture(
  db: SqliteD1Database,
  restoredJobState: "queued" | "running" = "queued"
): void {
  seedInstallation(db, {
    installationId: SUPPRESSED_INSTALLATION,
    suffix: "0001",
    seed: 1,
    total: 50,
    includeRestoredPrivateArtifacts: true
  });
  seedInstallation(db, {
    installationId: RETAINED_INSTALLATION,
    suffix: "0002",
    seed: 2,
    total: 20,
    includeRestoredPrivateArtifacts: false
  });
  seedInstallation(db, {
    installationId: RESTORED_JOB_INSTALLATION,
    suffix: "0003",
    seed: 3,
    total: 30,
    includeRestoredPrivateArtifacts: false
  });
  db.database
    .prepare(
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
      WHERE installation_id = ?`
    )
    .run(NOW, EXPIRES_AT, RESTORED_JOB_INSTALLATION);
  seedRestoredDeletionJob(db, restoredJobState);
  seedRestoredMutationGuardShadows(db);
  db.database
    .prepare(
      `INSERT INTO anonymous_rollups (
        period_start, period_end, scope, provider, model_family, tool,
        compaction_version, eligible_cohort_count, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, reasoning_tokens, other_tokens,
        total_tokens, created_at
      ) VALUES ('2026-06-01', '2026-06-02', 'all', 'other', 'all', 'all',
        'day-all-v1', 20, 100, 0, 0, 0, 0, 0, 100, ?)`
    )
    .run(NOW);
  db.database
    .prepare(
      `INSERT INTO public_totals_cache (
        scope, day_or_all, all_time_tokens, today_utc_tokens, contributors,
        generated_at, data_revision
      ) VALUES ('global', 'all', '200', '100', '3', ?, 'restored-stale-v1')`
    )
    .run(NOW);
}

function defaultExpectations(): D1RestoreDrillExpectations {
  return Object.freeze({
    activeSuppressionCount: 2,
    restoredInstallationCount: 3,
    purgedInstallationCount: 2,
    projectionChecksum: projectionChecksum("120", "20", "1")
  });
}

function createRunner(
  db: SqliteD1Database,
  ledger: FixtureSuppressionLedger,
  input: Readonly<{
    expectations?: D1RestoreDrillExpectations;
    maxRestoredInstallations?: number;
    maxActiveSuppressions?: number;
  }> = {}
) {
  return createD1SuppressionAwareRestoreDrill(
    db,
    {
      credentials: new MarkerDeriver(),
      suppressionLedger: ledger
    },
    {
      expectations: input.expectations ?? defaultExpectations(),
      ...(input.maxRestoredInstallations === undefined
        ? {}
        : { maxRestoredInstallations: input.maxRestoredInstallations }),
      ...(input.maxActiveSuppressions === undefined
        ? {}
        : { maxActiveSuppressions: input.maxActiveSuppressions }),
      now: () => new Date(NOW),
      createRevisionId: () => "restore_drill_revision_0001"
    }
  );
}

function staleProjection(db: SqliteD1Database): unknown {
  return db.database
    .prepare(
      `SELECT all_time_tokens AS allTimeTokens,
        today_utc_tokens AS todayUtcTokens, contributors
      FROM public_totals_cache`
    )
    .get();
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) db.close();
});

describe("suppression-aware isolated D1 restore drill", () => {
  it("strictly checks count-only projection checksum input", async () => {
    await expect(
      checksumD1RestoreProjection({
        allTimeTokenCount: "20",
        todayUtcTokenCount: "20",
        contributorCount: "1"
      })
    ).resolves.toBe(projectionChecksum("20", "20", "1"));
    await expect(
      checksumD1RestoreProjection({
        allTimeTokenCount: "1",
        todayUtcTokenCount: "2",
        contributorCount: "0"
      })
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  it("replays suppression before purge/rebuild and returns counts and checksums only", async () => {
    const db = database();
    seedRestoredFixture(db);
    const ledger = new FixtureSuppressionLedger();
    const evidence = await createRunner(db, ledger)();

    expect(evidence).toMatchObject({
      activeSuppressionCount: 2,
      restoredInstallationCount: 3,
      purgedInstallationCount: 2,
      attributableResidueCount: 0,
      credentialResidueCount: 0,
      shareResidueCount: 0,
      allTimeTokenCount: "120",
      todayUtcTokenCount: "20",
      contributorCount: "1",
      projectionChecksum: projectionChecksum("120", "20", "1")
    });
    expect(evidence.evidenceChecksum).toBe(evidenceChecksum(evidence));
    expect(Object.keys(evidence)).toEqual([
      "activeSuppressionCount",
      "restoredInstallationCount",
      "purgedInstallationCount",
      "attributableResidueCount",
      "credentialResidueCount",
      "shareResidueCount",
      "allTimeTokenCount",
      "todayUtcTokenCount",
      "contributorCount",
      "projectionChecksum",
      "evidenceChecksum"
    ]);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(ledger.calls).toBe(2);

    expect(
      db.database
        .prepare(
          `SELECT status, upload_token_id AS uploadTokenId,
            deletion_token_id AS deletionTokenId
          FROM installations WHERE installation_id = ?`
        )
        .get(SUPPRESSED_INSTALLATION)
    ).toEqual({
      status: "deleted",
      uploadTokenId: null,
      deletionTokenId: null
    });
    for (const table of [
      "usage_daily_current",
      "collector_window_bindings",
      "ingest_batches",
      "quarantine_events",
      "consent_receipts",
      "share_cards",
      "deletion_jobs",
      "mutation_guard_installations",
      "mutation_guard_batches",
      "mutation_guard_authorities",
      "mutation_guard_usage",
      "mutation_guard_deletions"
    ]) {
      expect(
        db.database
          .prepare(
            `SELECT count(*) AS count FROM ${table} WHERE installation_id = ?`
          )
          .get(SUPPRESSED_INSTALLATION)
      ).toEqual({ count: 0 });
    }
    expect(
      db.database.prepare("SELECT count(*) AS count FROM mutation_guards").get()
    ).toEqual({ count: 0 });
    expect(
      db.database
        .prepare(
          "SELECT status FROM installations WHERE installation_id = ?"
        )
        .get(RETAINED_INSTALLATION)
    ).toEqual({ status: "active" });
    expect(
      db.database
        .prepare(
          `SELECT status, upload_token_id AS uploadTokenId,
            deletion_token_id AS deletionTokenId
          FROM installations WHERE installation_id = ?`
        )
        .get(RESTORED_JOB_INSTALLATION)
    ).toEqual({
      status: "deleted",
      uploadTokenId: null,
      deletionTokenId: null
    });
    expect(staleProjection(db)).toEqual({
      allTimeTokens: "120",
      todayUtcTokens: "20",
      contributors: "1"
    });
    expect(
      db.database.prepare("SELECT count(*) AS count FROM aggregate_dirty").get()
    ).toEqual({ count: 0 });

    const serialized = JSON.stringify(evidence);
    for (const forbidden of [
      SUPPRESSED_INSTALLATION,
      RETAINED_INSTALLATION,
      RESTORED_JOB_INSTALLATION,
      SUPPRESSED_MARKER,
      RETAINED_MARKER,
      RESTORED_JOB_MARKER,
      "upload_public_0001",
      "delete_public_0001",
      "status_queued_00000001",
      "replay_queued_00000001"
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(JSON.stringify(db.boundValues)).not.toContain(SUPPRESSED_MARKER);
  });

  it.each(["queued", "running"] as const)(
    "irreversibly removes an unexpired restored %s deletion-job credential",
    async (state) => {
      const db = database();
      seedRestoredFixture(db, state);
      expect(
        db.database.prepare("SELECT state FROM deletion_jobs").get()
      ).toEqual({ state });

      const evidence = await createRunner(
        db,
        new FixtureSuppressionLedger()
      )();

      expect(evidence.credentialResidueCount).toBe(0);
      expect(
        db.database.prepare("SELECT count(*) AS count FROM deletion_jobs").get()
      ).toEqual({ count: 0 });
      expect(JSON.stringify(evidence)).not.toContain(`status_${state}`);
      expect(JSON.stringify(evidence)).not.toContain(`replay_${state}`);
    }
  );

  it("fails before mutation or rebuild when the independent ledger is unavailable", async () => {
    const db = database();
    seedRestoredFixture(db);
    const ledger = new FixtureSuppressionLedger();
    const canary = `prompt=PRIVATE:${SUPPRESSED_INSTALLATION}:${SUPPRESSED_MARKER}`;
    ledger.failure = new Error(canary);

    try {
      await createRunner(db, ledger)();
      throw new Error("expected restore drill failure");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(D1RestoreDrillError);
      expect(error).toMatchObject({ code: "SUPPRESSION_REPLAY_FAILED" });
      expect(JSON.stringify(error)).not.toContain(canary);
      expect(JSON.stringify(error)).not.toContain(SUPPRESSED_INSTALLATION);
      expect(JSON.stringify(error)).not.toContain(SUPPRESSED_MARKER);
    }
    expect(
      db.database
        .prepare("SELECT status FROM installations WHERE installation_id = ?")
        .get(SUPPRESSED_INSTALLATION)
    ).toEqual({ status: "active" });
    expect(staleProjection(db)).toEqual({
      allTimeTokens: "200",
      todayUtcTokens: "100",
      contributors: "3"
    });
  });

  it.each([
    {
      name: "duplicate marker",
      entries: [
        {
          suppressionMarker: SUPPRESSED_MARKER,
          recordedAt: RECORDED_AT,
          expiresAt: EXPIRES_AT
        },
        {
          suppressionMarker: SUPPRESSED_MARKER,
          recordedAt: RECORDED_AT,
          expiresAt: EXPIRES_AT
        }
      ]
    },
    {
      name: "unknown field",
      entries: [
        {
          suppressionMarker: SUPPRESSED_MARKER,
          recordedAt: RECORDED_AT,
          expiresAt: EXPIRES_AT,
          extra: "rejected"
        }
      ]
    },
    {
      name: "non-canonical instant",
      entries: [
        {
          suppressionMarker: SUPPRESSED_MARKER,
          recordedAt: "2026-07-15T18:00:00Z",
          expiresAt: EXPIRES_AT
        }
      ]
    },
    {
      name: "future recording time",
      entries: [
        {
          suppressionMarker: SUPPRESSED_MARKER,
          recordedAt: "2026-07-15T18:30:00.001Z",
          expiresAt: EXPIRES_AT
        }
      ]
    },
    {
      name: "expired marker",
      entries: [
        {
          suppressionMarker: SUPPRESSED_MARKER,
          recordedAt: RECORDED_AT,
          expiresAt: NOW
        }
      ]
    },
    {
      name: "overlong retention",
      entries: [
        {
          suppressionMarker: SUPPRESSED_MARKER,
          recordedAt: "2026-06-01T18:00:00.000Z",
          expiresAt: EXPIRES_AT
        }
      ]
    },
    {
      name: "invalid marker digest",
      entries: [
        {
          suppressionMarker: "not-a-digest",
          recordedAt: RECORDED_AT,
          expiresAt: EXPIRES_AT
        }
      ]
    }
  ])("rejects $name ledger data before mutation", async ({ entries }) => {
    const db = database();
    seedRestoredFixture(db);
    const ledger = new FixtureSuppressionLedger();
    ledger.entries = entries as readonly SuppressionLedgerEntry[];

    await expect(createRunner(db, ledger)()).rejects.toMatchObject({
      code: "SUPPRESSION_REPLAY_FAILED"
    });
    expect(
      db.database
        .prepare("SELECT status FROM installations WHERE installation_id = ?")
        .get(SUPPRESSED_INSTALLATION)
    ).toEqual({ status: "active" });
    expect(staleProjection(db)).toEqual({
      allTimeTokens: "200",
      todayUtcTokens: "100",
      contributors: "3"
    });
  });

  it("enforces installation and active-suppression bounds before purge", async () => {
    const installationBoundDb = database();
    seedRestoredFixture(installationBoundDb);
    await expect(
      createRunner(installationBoundDb, new FixtureSuppressionLedger(), {
        maxRestoredInstallations: 1,
        expectations: Object.freeze({
          ...defaultExpectations(),
          restoredInstallationCount: 1,
          purgedInstallationCount: 1
        })
      })()
    ).rejects.toMatchObject({ code: "BOUND_EXCEEDED" });
    expect(
      installationBoundDb.database
        .prepare("SELECT status FROM installations WHERE installation_id = ?")
        .get(SUPPRESSED_INSTALLATION)
    ).toEqual({ status: "active" });

    const suppressionBoundDb = database();
    seedRestoredFixture(suppressionBoundDb);
    const ledger = new FixtureSuppressionLedger();
    ledger.entries = Object.freeze([
      ...ledger.entries,
      Object.freeze({
        suppressionMarker: base64Url(95),
        recordedAt: RECORDED_AT,
        expiresAt: EXPIRES_AT
      })
    ]);
    await expect(
      createRunner(suppressionBoundDb, ledger, {
        maxActiveSuppressions: 1,
        expectations: Object.freeze({
          ...defaultExpectations(),
          activeSuppressionCount: 1,
          purgedInstallationCount: 1
        })
      })()
    ).rejects.toMatchObject({ code: "BOUND_EXCEEDED" });
    expect(
      suppressionBoundDb.database
        .prepare("SELECT status FROM installations WHERE installation_id = ?")
        .get(SUPPRESSED_INSTALLATION)
    ).toEqual({ status: "active" });
  });

  it("detects share residue and refuses to rebuild a restored public projection", async () => {
    const db = database();
    seedRestoredFixture(db);
    db.database.exec(`CREATE TRIGGER preserve_restored_share
      BEFORE DELETE ON share_cards
      BEGIN
        SELECT RAISE(IGNORE);
      END`);

    await expect(
      createRunner(db, new FixtureSuppressionLedger())()
    ).rejects.toMatchObject({ code: "RESIDUE_DETECTED" });
    expect(
      db.database.prepare("SELECT count(*) AS count FROM share_cards").get()
    ).toEqual({ count: 1 });
    expect(staleProjection(db)).toEqual({
      allTimeTokens: "200",
      todayUtcTokens: "100",
      contributors: "3"
    });
    expect(
      db.database.prepare("SELECT count(*) AS count FROM aggregate_dirty").get()
    ).toEqual({ count: 1 });
  });

  it("detects a purge that fails to revoke the restored lifecycle credentials", async () => {
    const db = database();
    seedRestoredFixture(db);
    db.database.exec(`CREATE TRIGGER preserve_restored_credentials
      BEFORE UPDATE OF status ON installations
      WHEN OLD.installation_id = '${SUPPRESSED_INSTALLATION}'
      BEGIN
        SELECT RAISE(IGNORE);
      END`);

    await expect(
      createRunner(db, new FixtureSuppressionLedger())()
    ).rejects.toMatchObject({ code: "RESIDUE_DETECTED" });
    expect(
      db.database
        .prepare(
          `SELECT status, upload_token_id IS NOT NULL AS hasUpload,
            deletion_token_id IS NOT NULL AS hasDeletion
          FROM installations WHERE installation_id = ?`
        )
        .get(SUPPRESSED_INSTALLATION)
    ).toEqual({ status: "active", hasUpload: 1, hasDeletion: 1 });
    expect(staleProjection(db)).toEqual({
      allTimeTokens: "200",
      todayUtcTokens: "100",
      contributors: "3"
    });
  });

  it("detects a restored mutation-guard credential shadow and refuses to rebuild", async () => {
    const db = database();
    seedRestoredFixture(db);
    db.database.exec(`CREATE TRIGGER preserve_restored_guard_shadow
      BEFORE DELETE ON mutation_guards
      WHEN OLD.request_id = '${RESTORED_USAGE_GUARD}'
      BEGIN
        SELECT RAISE(IGNORE);
      END`);

    await expect(
      createRunner(db, new FixtureSuppressionLedger())()
    ).rejects.toMatchObject({ code: "RESIDUE_DETECTED" });
    expect(
      db.database
        .prepare(
          `SELECT expected_upload_token_hmac IS NOT NULL AS hasUploadHmac,
            expected_deletion_token_hmac IS NOT NULL AS hasDeletionHmac
          FROM mutation_guard_installations WHERE request_id = ?`
        )
        .get(RESTORED_USAGE_GUARD)
    ).toEqual({ hasUploadHmac: 1, hasDeletionHmac: 1 });
    expect(staleProjection(db)).toEqual({
      allTimeTokens: "200",
      todayUtcTokens: "100",
      contributors: "3"
    });
  });

  it("rechecks the independent suppression snapshot before rebuilding", async () => {
    const db = database();
    seedRestoredFixture(db);
    const ledger = new FixtureSuppressionLedger();
    ledger.afterFirstEntries = Object.freeze([
      ...ledger.entries,
      Object.freeze({
        suppressionMarker: base64Url(94),
        recordedAt: RECORDED_AT,
        expiresAt: EXPIRES_AT
      })
    ]);

    await expect(createRunner(db, ledger)()).rejects.toMatchObject({
      code: "SUPPRESSION_REPLAY_FAILED"
    });
    expect(ledger.calls).toBe(2);
    expect(staleProjection(db)).toEqual({
      allTimeTokens: "200",
      todayUtcTokens: "100",
      contributors: "3"
    });
  });

  it("rejects a rebuilt projection that differs from the approved count checksum", async () => {
    const db = database();
    seedRestoredFixture(db);
    const wrongExpectations = Object.freeze({
      ...defaultExpectations(),
      projectionChecksum: projectionChecksum("0", "0", "0")
    });

    await expect(
      createRunner(db, new FixtureSuppressionLedger(), {
        expectations: wrongExpectations
      })()
    ).rejects.toMatchObject({ code: "PROJECTION_REJECTED" });
    expect(staleProjection(db)).toEqual({
      allTimeTokens: "120",
      todayUtcTokens: "20",
      contributors: "1"
    });
  });
});
