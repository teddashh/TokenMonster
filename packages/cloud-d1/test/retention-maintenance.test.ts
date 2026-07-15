import type {
  D1RetentionDeletionCounts,
  D1RetentionMaintenanceStoragePort
} from "../src/index.js";
import {
  createD1RetentionMaintenanceProcessor,
  createD1RetentionMaintenanceStorage,
  D1RetentionMaintenanceError
} from "../src/index.js";
import { describe, expect, it } from "vitest";

import { SqliteD1Database } from "./sqlite-d1.js";

const CUTOFF = "2026-07-15T18:30:00.000Z";
const CREATED = "2026-07-01T00:00:00.000Z";
const PAST = "2026-07-14T18:30:00.000Z";
const FUTURE = "2026-08-14T18:30:00.000Z";

const ACTIVE = `ins_${"A".repeat(22)}`;
const EXPIRED_TOMBSTONE = `ins_${"D".repeat(22)}`;
const LIVE_STATUS_TOMBSTONE = `ins_${"L".repeat(22)}`;

function rows(
  db: SqliteD1Database,
  query: string
): readonly Readonly<Record<string, unknown>>[] {
  return db.database.prepare(query).all() as readonly Readonly<
    Record<string, unknown>
  >[];
}

function count(db: SqliteD1Database, table: string): number {
  const row = db.database
    .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .get() as Readonly<{ count: number }>;
  return row.count;
}

function insertActiveInstallation(
  db: SqliteD1Database,
  installationId: string,
  marker: number
): void {
  db.database.prepare(`INSERT INTO installations (
    installation_id, upload_token_id, upload_token_hmac, upload_hmac_key_id,
    deletion_token_id, deletion_token_hmac, deletion_hmac_key_id, status,
    consent_document_revision, created_at, credentials_rotated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    installationId,
    `upload_${String(marker).padStart(16, "0")}`,
    new Uint8Array(32).fill(marker),
    "upload-v1",
    `delete_${String(marker).padStart(16, "0")}`,
    new Uint8Array(32).fill(marker + 32),
    "delete-v1",
    "active",
    "contribution-v1",
    CREATED,
    CREATED
  );
}

function insertDeletedInstallation(
  db: SqliteD1Database,
  installationId: string,
  receiptExpiresAt: string
): void {
  db.database.prepare(`INSERT INTO installations (
    installation_id, status, consent_document_revision, created_at,
    credentials_rotated_at, deleting_at, deleted_at, receipt_expires_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    installationId,
    "deleted",
    "contribution-v1",
    CREATED,
    CREATED,
    CREATED,
    CREATED,
    receiptExpiresAt
  );
}

function insertConsent(
  db: SqliteD1Database,
  installationId: string,
  marker: string,
  expiresAt: string
): void {
  db.database.prepare(`INSERT INTO consent_receipts (
    event_id, installation_id, purpose, document_revision, granted,
    occurred_at, recorded_at, expires_at
  ) VALUES (?, ?, 'contribution', 'contribution-v1', 1, ?, ?, ?)`).run(
    `consent_${marker.repeat(16)}`,
    installationId,
    CREATED,
    CREATED,
    expiresAt
  );
}

function insertBinding(
  db: SqliteD1Database,
  installationId: string,
  bucketStart: string,
  expiresAt: string
): void {
  db.database.prepare(`INSERT INTO collector_window_bindings (
    installation_id, bucket_start, collector_kind, adapter_version,
    source_version, created_at, expires_at
  ) VALUES (?, ?, 'tokscale', '0.1.0', '4.5.2', ?, ?)`).run(
    installationId,
    bucketStart,
    CREATED,
    expiresAt
  );
}

function insertUsage(
  db: SqliteD1Database,
  installationId: string,
  bucketStart: string,
  tool: string,
  expiresAt: string,
  marker: number
): void {
  db.database.prepare(`INSERT INTO usage_daily_current (
    installation_id, bucket_start, provider, model_family, tool,
    value_quality, revision, input_tokens, output_tokens, cache_read_tokens,
    cache_write_tokens, reasoning_tokens, other_tokens, total_tokens,
    collector_kind, adapter_version, source_version, row_hash,
    quarantine_status, created_at, updated_at, expires_at
  ) VALUES (?, ?, 'openai', 'gpt-5', ?, 'exact', 1, 2, 1, 0, 0, 0, 0, 3,
    'tokscale', '0.1.0', '4.5.2', ?, 'accepted', ?, ?, ?)`).run(
    installationId,
    bucketStart,
    tool,
    new Uint8Array(32).fill(marker),
    CREATED,
    CREATED,
    expiresAt
  );
}

function insertBatch(
  db: SqliteD1Database,
  installationId: string,
  batchId: string,
  expiresAt: string,
  marker: number
): void {
  db.database.prepare(`INSERT INTO ingest_batches (
    installation_id, batch_id, payload_hash, status, bucket_count,
    applied_bucket_count, stale_bucket_count, idempotent_bucket_count,
    quarantined_bucket_count, created_at, expires_at
  ) VALUES (?, ?, ?, 'quarantined', 1, 0, 0, 0, 1, ?, ?)`).run(
    installationId,
    batchId,
    new Uint8Array(32).fill(marker),
    CREATED,
    expiresAt
  );
}

function insertQuarantine(
  db: SqliteD1Database,
  installationId: string,
  batchId: string,
  marker: string,
  expiresAt: string
): void {
  db.database.prepare(`INSERT INTO quarantine_events (
    event_id, installation_id, batch_id, bucket_index, reason_code, decision,
    created_at, decided_at, expires_at
  ) VALUES (?, ?, ?, 0, 'ROW_INVALID', 'quarantined', ?, ?, ?)`).run(
    `quarantine_${marker.repeat(16)}`,
    installationId,
    batchId,
    CREATED,
    CREATED,
    expiresAt
  );
}

function insertShare(
  db: SqliteD1Database,
  installationId: string,
  marker: string,
  expiresAt: string,
  revokedAt: string | null = null
): void {
  db.database.prepare(`INSERT INTO share_cards (
    share_id, installation_id, character_asset_id, trait_ids_json,
    reason_codes_json, coarse_time_window, token_band, token_total, locale,
    theme, created_at, expires_at, revoked_at
  ) VALUES (?, ?, 'tokenmonster.placeholder.v1',
    '["cli-native","cache-savvy"]', '["tool-dominance"]', '28-days',
    'small', '3', 'zh-TW', 'dark', ?, ?, ?)`).run(
    marker.repeat(32),
    installationId,
    CREATED,
    expiresAt,
    revokedAt
  );
}

function insertSecurityEvent(
  db: SqliteD1Database,
  marker: string,
  expiresAt: string,
  digestMarker: number
): void {
  db.database.prepare(`INSERT INTO security_rate_events (
    event_id, route_class, reason_code, rate_key_hmac, created_at, expires_at
  ) VALUES (?, 'ingest', 'BURST_LIMIT', ?, ?, ?)`).run(
    `security_${marker.repeat(16)}`,
    new Uint8Array(32).fill(digestMarker),
    CREATED,
    expiresAt
  );
}

function insertDeletionReceipt(
  db: SqliteD1Database,
  installationId: string,
  marker: string,
  expiresAt: string,
  digestMarker: number
): void {
  db.database.prepare(`INSERT INTO deletion_jobs (
    job_id, installation_id, idempotency_key, status_token_id,
    status_token_hmac, status_hmac_key_id, replay_token_id,
    replay_token_hmac, replay_hmac_key_id, state,
    anonymous_historical_totals_retained, requested_at, started_at,
    finished_at, expires_at
  ) VALUES (?, ?, ?, ?, ?, 'status-v1', ?, ?, 'delete-v1', 'complete', 1,
    ?, ?, ?, ?)`).run(
    `del_${marker.repeat(22)}`,
    installationId,
    `idem_${marker.repeat(22)}`,
    `status_${marker.repeat(16)}`,
    new Uint8Array(32).fill(digestMarker),
    `replay_${marker.repeat(16)}`,
    new Uint8Array(32).fill(digestMarker + 32),
    CREATED,
    CREATED,
    CREATED,
    expiresAt
  );
}

function insertGuard(
  db: SqliteD1Database,
  marker: string,
  expiresAt: string
): void {
  db.database.prepare(`INSERT INTO mutation_guards (
    request_id, operation, expires_at
  ) VALUES (?, 'ingest', ?)`).run(`guard_${marker.repeat(16)}`, expiresAt);
}

function seedAllRetentionClasses(db: SqliteD1Database): void {
  insertActiveInstallation(db, ACTIVE, 1);
  insertDeletedInstallation(db, EXPIRED_TOMBSTONE, PAST);
  insertDeletedInstallation(db, LIVE_STATUS_TOMBSTONE, PAST);

  const expiredBucket = "2026-06-01T00:00:00.000Z";
  const futureBucket = "2026-07-01T00:00:00.000Z";
  insertBinding(db, ACTIVE, expiredBucket, PAST);
  insertUsage(db, ACTIVE, expiredBucket, "codex-expired", FUTURE, 1);
  insertBinding(db, ACTIVE, futureBucket, FUTURE);
  insertUsage(db, ACTIVE, futureBucket, "codex-live", FUTURE, 2);

  const expiredBatch = `batch_${"E".repeat(16)}`;
  const futureBatch = `batch_${"F".repeat(16)}`;
  insertBatch(db, ACTIVE, expiredBatch, PAST, 3);
  insertQuarantine(db, ACTIVE, expiredBatch, "E", FUTURE);
  insertBatch(db, ACTIVE, futureBatch, FUTURE, 4);
  insertQuarantine(db, ACTIVE, futureBatch, "F", FUTURE);

  insertConsent(db, ACTIVE, "E", PAST);
  insertConsent(db, ACTIVE, "F", FUTURE);
  insertShare(db, ACTIVE, "e", PAST);
  insertShare(db, ACTIVE, "f", FUTURE);
  insertShare(db, ACTIVE, "r", FUTURE, PAST);
  insertSecurityEvent(db, "E", PAST, 5);
  insertSecurityEvent(db, "F", FUTURE, 6);
  insertGuard(db, "E", PAST);
  insertGuard(db, "F", FUTURE);

  const tombstoneBucket = "2026-06-02T00:00:00.000Z";
  const tombstoneBatch = `batch_${"D".repeat(16)}`;
  insertBinding(db, EXPIRED_TOMBSTONE, tombstoneBucket, FUTURE);
  insertUsage(
    db,
    EXPIRED_TOMBSTONE,
    tombstoneBucket,
    "codex-tombstone",
    FUTURE,
    7
  );
  insertBatch(db, EXPIRED_TOMBSTONE, tombstoneBatch, FUTURE, 8);
  insertQuarantine(
    db,
    EXPIRED_TOMBSTONE,
    tombstoneBatch,
    "D",
    FUTURE
  );
  insertConsent(db, EXPIRED_TOMBSTONE, "D", FUTURE);
  insertShare(db, EXPIRED_TOMBSTONE, "d", FUTURE);
  insertDeletionReceipt(db, EXPIRED_TOMBSTONE, "D", PAST, 9);

  // This intentionally inconsistent fixture proves the status job's own TTL
  // wins over an earlier installation receipt expiry.
  insertDeletionReceipt(db, LIVE_STATUS_TOMBSTONE, "L", FUTURE, 10);
}

function zeroCounts(): D1RetentionDeletionCounts {
  return Object.freeze({
    usageBuckets: 0,
    authorityBindings: 0,
    quarantineEvents: 0,
    batchReceipts: 0,
    consentReceipts: 0,
    shares: 0,
    securityRateEvents: 0,
    deletionReceipts: 0,
    installationTombstones: 0,
    mutationGuards: 0
  });
}

describe("D1 retention maintenance", () => {
  it("hard-deletes every expired TTL class while preserving live records and status receipts", async () => {
    const db = new SqliteD1Database();
    try {
      seedAllRetentionClasses(db);
      const process = createD1RetentionMaintenanceProcessor(
        createD1RetentionMaintenanceStorage(db),
        { maxRecords: 100, now: () => new Date(CUTOFF) }
      );

      const result = await process();

      expect(result).toEqual({
        deletedRecords: 17,
        projectionInvalidated: true,
        counts: {
          usageBuckets: 2,
          authorityBindings: 2,
          quarantineEvents: 2,
          batchReceipts: 2,
          consentReceipts: 2,
          shares: 3,
          securityRateEvents: 1,
          deletionReceipts: 1,
          installationTombstones: 1,
          mutationGuards: 1
        }
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.counts)).toBe(true);

      expect(count(db, "usage_daily_current")).toBe(1);
      expect(count(db, "collector_window_bindings")).toBe(1);
      expect(count(db, "quarantine_events")).toBe(1);
      expect(count(db, "ingest_batches")).toBe(1);
      expect(count(db, "consent_receipts")).toBe(1);
      expect(count(db, "share_cards")).toBe(1);
      expect(count(db, "security_rate_events")).toBe(1);
      expect(count(db, "mutation_guards")).toBe(1);
      expect(
        rows(
          db,
          `SELECT installation_id FROM installations ORDER BY installation_id`
        )
      ).toEqual([
        { installation_id: ACTIVE },
        { installation_id: LIVE_STATUS_TOMBSTONE }
      ]);
      expect(
        rows(db, `SELECT installation_id FROM deletion_jobs`)
      ).toEqual([{ installation_id: LIVE_STATUS_TOMBSTONE }]);
      expect(rows(db, `SELECT dirty_revision FROM aggregate_dirty`)).toEqual([
        { dirty_revision: 3 }
      ]);

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("ins_");
      expect(serialized).not.toContain("del_");
      expect(serialized).not.toContain("prompt");
    } finally {
      db.close();
    }
  });

  it("enforces one global direct-root limit across all table classes", async () => {
    const db = new SqliteD1Database();
    try {
      for (let index = 0; index < 30; index += 1) {
        insertSecurityEvent(
          db,
          index.toString(36).padStart(3, "0"),
          PAST,
          index + 1
        );
      }
      const process = createD1RetentionMaintenanceProcessor(
        createD1RetentionMaintenanceStorage(db),
        { maxRecords: 10, now: () => new Date(CUTOFF) }
      );

      await expect(process()).resolves.toEqual({
        deletedRecords: 10,
        projectionInvalidated: false,
        counts: { ...zeroCounts(), securityRateEvents: 10 }
      });
      expect(count(db, "security_rate_events")).toBe(20);
    } finally {
      db.close();
    }
  });

  it("preserves compaction-owned usage and bindings while draining other expired roots", async () => {
    const db = new SqliteD1Database();
    try {
      seedAllRetentionClasses(db);
      const process = createD1RetentionMaintenanceProcessor(
        createD1RetentionMaintenanceStorage(db, {
          preserveCompactionInputs: true
        }),
        { maxRecords: 100, now: () => new Date(CUTOFF) }
      );

      await expect(process()).resolves.toEqual({
        deletedRecords: 12,
        projectionInvalidated: false,
        counts: {
          ...zeroCounts(),
          quarantineEvents: 2,
          batchReceipts: 2,
          consentReceipts: 2,
          shares: 3,
          securityRateEvents: 1,
          deletionReceipts: 1,
          mutationGuards: 1
        }
      });

      expect(count(db, "usage_daily_current")).toBe(3);
      expect(count(db, "collector_window_bindings")).toBe(3);
      expect(count(db, "installations")).toBe(3);
      expect(count(db, "quarantine_events")).toBe(1);
      expect(count(db, "ingest_batches")).toBe(1);
      expect(count(db, "aggregate_dirty")).toBe(0);
    } finally {
      db.close();
    }
  });

  it("fails closed on invalid limits, clocks, or storage count claims", async () => {
    const storage: D1RetentionMaintenanceStoragePort = {
      async deleteExpiredRecords() {
        return Object.freeze({ ...zeroCounts(), usageBuckets: 11 });
      }
    };

    expect(() =>
      createD1RetentionMaintenanceProcessor(storage, { maxRecords: 9 })
    ).toThrowError(D1RetentionMaintenanceError);
    await expect(
      createD1RetentionMaintenanceProcessor(storage, {
        maxRecords: 10,
        now: () => new Date("invalid")
      })()
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    await expect(
      createD1RetentionMaintenanceProcessor(storage, {
        maxRecords: 10,
        now: () => new Date(CUTOFF)
      })()
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });

  it("rolls back the dirty marker and delete together on a D1 batch failure", async () => {
    const db = new SqliteD1Database();
    try {
      insertActiveInstallation(db, ACTIVE, 1);
      const bucket = "2026-06-01T00:00:00.000Z";
      insertBinding(db, ACTIVE, bucket, FUTURE);
      insertUsage(db, ACTIVE, bucket, "codex-private", PAST, 1);
      const canary = "prompt=PRIVATE";
      db.database.exec(`CREATE TRIGGER fail_retention_delete
        BEFORE DELETE ON usage_daily_current
        BEGIN
          SELECT RAISE(ABORT, '${canary}');
        END`);
      const process = createD1RetentionMaintenanceProcessor(
        createD1RetentionMaintenanceStorage(db),
        { maxRecords: 10, now: () => new Date(CUTOFF) }
      );

      try {
        await process();
        throw new Error("expected retention failure");
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(D1RetentionMaintenanceError);
        expect(JSON.stringify(error)).not.toContain(canary);
      }
      expect(count(db, "usage_daily_current")).toBe(1);
      expect(count(db, "aggregate_dirty")).toBe(0);
    } finally {
      db.close();
    }
  });
});
