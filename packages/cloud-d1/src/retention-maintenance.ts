import type {
  D1MutationDatabaseLike,
  D1MutationPreparedStatementLike,
  D1MutationResultLike
} from "./mutation-storage.js";

const DEFAULT_MAX_RECORDS = 100;
const MIN_MAX_RECORDS = 10;
const MAX_MAX_RECORDS = 500;

const COUNT_KEYS = [
  "usageBuckets",
  "authorityBindings",
  "quarantineEvents",
  "batchReceipts",
  "consentReceipts",
  "shares",
  "securityRateEvents",
  "deletionReceipts",
  "installationTombstones",
  "mutationGuards"
] as const;

type RetentionCountKey = (typeof COUNT_KEYS)[number];

export type D1RetentionDatabaseLike = Pick<
  D1MutationDatabaseLike,
  "batch" | "prepare"
>;

export type D1RetentionMaintenanceErrorCode =
  | "INPUT_INVALID"
  | "SERVICE_UNAVAILABLE";

export class D1RetentionMaintenanceError extends Error {
  override readonly name = "D1RetentionMaintenanceError";

  constructor(readonly code: D1RetentionMaintenanceErrorCode) {
    super(
      code === "INPUT_INVALID"
        ? "The retention maintenance adapter received invalid input."
        : "The retention maintenance service is unavailable."
    );
  }

  toJSON(): Readonly<{
    name: "D1RetentionMaintenanceError";
    code: D1RetentionMaintenanceErrorCode;
  }> {
    return Object.freeze({ name: this.name, code: this.code });
  }
}

export interface D1RetentionDeletionCounts {
  readonly usageBuckets: number;
  readonly authorityBindings: number;
  readonly quarantineEvents: number;
  readonly batchReceipts: number;
  readonly consentReceipts: number;
  readonly shares: number;
  readonly securityRateEvents: number;
  readonly deletionReceipts: number;
  readonly installationTombstones: number;
  readonly mutationGuards: number;
}

export interface D1RetentionMaintenanceStoragePort {
  /**
   * Deletes at most maxRecords direct TTL roots. Foreign-key children are
   * drained first, so installation and receipt cleanup never becomes an
   * unbounded cascade.
   */
  deleteExpiredRecords(input: Readonly<{
    cutoff: string;
    maxRecords: number;
  }>): Promise<D1RetentionDeletionCounts>;
}

export interface D1RetentionMaintenanceStorageOptions {
  /**
   * Leaves usage buckets and their authority bindings exclusively owned by
   * the anonymous compactor. Scheduled cloud maintenance must enable this so
   * retention cannot partially erase a complete day before its k-gate closes.
   * Defaults to false for explicit, standalone hard-retention drains.
   */
  readonly preserveCompactionInputs?: boolean;
}

export interface D1RetentionMaintenanceOptions {
  /** Direct TTL roots per invocation. Defaults to 100; hard range is 10..500. */
  readonly maxRecords?: number;
  /** Dependency injection exists for deterministic tests only. */
  readonly now?: () => Date;
}

export interface D1RetentionMaintenanceResult {
  /** Direct roots removed; bounded by maxRecords. */
  readonly deletedRecords: number;
  /** True when canonical public-current truth may have changed. */
  readonly projectionInvalidated: boolean;
  /** Content-free operational counts; never contains row identifiers. */
  readonly counts: D1RetentionDeletionCounts;
}

export type D1RetentionMaintenanceProcessor =
  () => Promise<D1RetentionMaintenanceResult>;

interface CleanupPlan {
  readonly countKey: RetentionCountKey;
  readonly deleteSql: string;
  readonly dirtySql?: string;
}

const TOMBSTONE_EXPIRED = `EXISTS (
  SELECT 1
  FROM installations AS expired_installation
  WHERE expired_installation.installation_id = target.installation_id
    AND expired_installation.status IN ('deleting', 'deleted')
    AND expired_installation.receipt_expires_at <= ?1
)`;

const DIRTY_UPSERT_SUFFIX = `
ON CONFLICT (singleton_key) DO UPDATE SET
  dirty_since = CASE
    WHEN excluded.dirty_since < aggregate_dirty.dirty_since
      THEN excluded.dirty_since
    ELSE aggregate_dirty.dirty_since
  END,
  reason = excluded.reason,
  dirty_revision = aggregate_dirty.dirty_revision + 1`;

const USAGE_ELIGIBLE = `(target.expires_at <= ?1
  OR EXISTS (
    SELECT 1
    FROM collector_window_bindings AS expired_binding
    WHERE expired_binding.installation_id = target.installation_id
      AND expired_binding.bucket_start = target.bucket_start
      AND expired_binding.expires_at <= ?1
  )
  OR ${TOMBSTONE_EXPIRED})`;

const USAGE_DIRTY = `INSERT INTO aggregate_dirty (
  singleton_key, dirty_since, reason, dirty_revision
)
SELECT 1, ?1, 'compaction', 1
WHERE EXISTS (
  SELECT 1 FROM usage_daily_current AS target WHERE ${USAGE_ELIGIBLE}
)
${DIRTY_UPSERT_SUFFIX}`;

const USAGE_DELETE = `DELETE FROM usage_daily_current AS target
WHERE rowid IN (
  SELECT target.rowid
  FROM usage_daily_current AS target
  WHERE ${USAGE_ELIGIBLE}
  ORDER BY target.expires_at, target.installation_id, target.bucket_start,
    target.provider, target.model_family, target.tool
  LIMIT ?2
)
AND ${USAGE_ELIGIBLE}`;

const AUTHORITY_ELIGIBLE = `(target.expires_at <= ?1
  OR ${TOMBSTONE_EXPIRED})
AND NOT EXISTS (
  SELECT 1
  FROM usage_daily_current AS usage
  WHERE usage.installation_id = target.installation_id
    AND usage.bucket_start = target.bucket_start
)`;

const AUTHORITY_DIRTY = `INSERT INTO aggregate_dirty (
  singleton_key, dirty_since, reason, dirty_revision
)
SELECT 1, ?1, 'compaction', 1
WHERE EXISTS (
  SELECT 1
  FROM collector_window_bindings AS target
  WHERE ${AUTHORITY_ELIGIBLE}
)
${DIRTY_UPSERT_SUFFIX}`;

const AUTHORITY_DELETE = `DELETE FROM collector_window_bindings AS target
WHERE rowid IN (
  SELECT target.rowid
  FROM collector_window_bindings AS target
  WHERE ${AUTHORITY_ELIGIBLE}
  ORDER BY target.expires_at, target.installation_id, target.bucket_start
  LIMIT ?2
)
AND ${AUTHORITY_ELIGIBLE}`;

const QUARANTINE_ELIGIBLE = `(target.expires_at <= ?1
  OR EXISTS (
    SELECT 1
    FROM ingest_batches AS expired_batch
    WHERE expired_batch.installation_id = target.installation_id
      AND expired_batch.batch_id = target.batch_id
      AND expired_batch.expires_at <= ?1
  )
  OR ${TOMBSTONE_EXPIRED})`;

const QUARANTINE_DELETE = `DELETE FROM quarantine_events AS target
WHERE rowid IN (
  SELECT target.rowid
  FROM quarantine_events AS target
  WHERE ${QUARANTINE_ELIGIBLE}
  ORDER BY target.expires_at, target.event_id
  LIMIT ?2
)
AND ${QUARANTINE_ELIGIBLE}`;

const BATCH_ELIGIBLE = `(target.expires_at <= ?1
  OR ${TOMBSTONE_EXPIRED})
AND NOT EXISTS (
  SELECT 1
  FROM quarantine_events AS quarantine
  WHERE quarantine.installation_id = target.installation_id
    AND quarantine.batch_id = target.batch_id
)`;

const BATCH_DELETE = `DELETE FROM ingest_batches AS target
WHERE rowid IN (
  SELECT target.rowid
  FROM ingest_batches AS target
  WHERE ${BATCH_ELIGIBLE}
  ORDER BY target.expires_at, target.installation_id, target.batch_id
  LIMIT ?2
)
AND ${BATCH_ELIGIBLE}`;

const CONSENT_ELIGIBLE = `(target.expires_at <= ?1
  OR ${TOMBSTONE_EXPIRED})`;

const CONSENT_DELETE = `DELETE FROM consent_receipts AS target
WHERE rowid IN (
  SELECT target.rowid
  FROM consent_receipts AS target
  WHERE ${CONSENT_ELIGIBLE}
  ORDER BY target.expires_at, target.event_id
  LIMIT ?2
)
AND ${CONSENT_ELIGIBLE}`;

const SHARE_ELIGIBLE = `(target.expires_at <= ?1
  OR (target.revoked_at IS NOT NULL AND target.revoked_at <= ?1)
  OR ${TOMBSTONE_EXPIRED})`;

const SHARE_DELETE = `DELETE FROM share_cards AS target
WHERE rowid IN (
  SELECT target.rowid
  FROM share_cards AS target
  WHERE ${SHARE_ELIGIBLE}
  ORDER BY COALESCE(target.revoked_at, target.expires_at), target.share_id
  LIMIT ?2
)
AND ${SHARE_ELIGIBLE}`;

const SECURITY_DELETE = `DELETE FROM security_rate_events
WHERE rowid IN (
  SELECT target.rowid
  FROM security_rate_events AS target
  WHERE target.expires_at <= ?1
  ORDER BY target.expires_at, target.event_id
  LIMIT ?2
)
AND expires_at <= ?1`;

// The job's own expires_at is the user-visible status receipt boundary. Even
// a malformed earlier installation tombstone expiry must not shorten it.
const DELETION_ELIGIBLE = `target.expires_at <= ?1`;

const DELETION_DELETE = `DELETE FROM deletion_jobs AS target
WHERE rowid IN (
  SELECT target.rowid
  FROM deletion_jobs AS target
  WHERE ${DELETION_ELIGIBLE}
  ORDER BY target.expires_at, target.job_id
  LIMIT ?2
)
AND ${DELETION_ELIGIBLE}`;

const INSTALLATION_ELIGIBLE = `target.status IN ('deleting', 'deleted')
AND target.receipt_expires_at <= ?1
AND NOT EXISTS (
  SELECT 1 FROM consent_receipts AS child
  WHERE child.installation_id = target.installation_id
)
AND NOT EXISTS (
  SELECT 1 FROM collector_window_bindings AS child
  WHERE child.installation_id = target.installation_id
)
AND NOT EXISTS (
  SELECT 1 FROM ingest_batches AS child
  WHERE child.installation_id = target.installation_id
)
AND NOT EXISTS (
  SELECT 1 FROM usage_daily_current AS child
  WHERE child.installation_id = target.installation_id
)
AND NOT EXISTS (
  SELECT 1 FROM share_cards AS child
  WHERE child.installation_id = target.installation_id
)
AND NOT EXISTS (
  SELECT 1 FROM deletion_jobs AS child
  WHERE child.installation_id = target.installation_id
)`;

const INSTALLATION_DIRTY = `INSERT INTO aggregate_dirty (
  singleton_key, dirty_since, reason, dirty_revision
)
SELECT 1, ?1, 'delete', 1
WHERE EXISTS (
  SELECT 1 FROM installations AS target WHERE ${INSTALLATION_ELIGIBLE}
)
${DIRTY_UPSERT_SUFFIX}`;

const INSTALLATION_DELETE = `DELETE FROM installations
WHERE rowid IN (
  SELECT target.rowid
  FROM installations AS target
  WHERE ${INSTALLATION_ELIGIBLE}
  ORDER BY target.receipt_expires_at, target.installation_id
  LIMIT ?2
)
AND status IN ('deleting', 'deleted')
AND receipt_expires_at <= ?1`;

const MUTATION_GUARD_DELETE = `DELETE FROM mutation_guards
WHERE rowid IN (
  SELECT target.rowid
  FROM mutation_guards AS target
  WHERE target.expires_at <= ?1
  ORDER BY target.expires_at, target.request_id
  LIMIT ?2
)
AND expires_at <= ?1`;

const CLEANUP_PLANS: readonly CleanupPlan[] = Object.freeze([
  Object.freeze({
    countKey: "usageBuckets",
    deleteSql: USAGE_DELETE,
    dirtySql: USAGE_DIRTY
  }),
  Object.freeze({
    countKey: "authorityBindings",
    deleteSql: AUTHORITY_DELETE,
    dirtySql: AUTHORITY_DIRTY
  }),
  Object.freeze({
    countKey: "quarantineEvents",
    deleteSql: QUARANTINE_DELETE
  }),
  Object.freeze({ countKey: "batchReceipts", deleteSql: BATCH_DELETE }),
  Object.freeze({ countKey: "consentReceipts", deleteSql: CONSENT_DELETE }),
  Object.freeze({ countKey: "shares", deleteSql: SHARE_DELETE }),
  Object.freeze({
    countKey: "securityRateEvents",
    deleteSql: SECURITY_DELETE
  }),
  Object.freeze({
    countKey: "deletionReceipts",
    deleteSql: DELETION_DELETE
  }),
  Object.freeze({
    countKey: "installationTombstones",
    deleteSql: INSTALLATION_DELETE,
    dirtySql: INSTALLATION_DIRTY
  }),
  Object.freeze({
    countKey: "mutationGuards",
    deleteSql: MUTATION_GUARD_DELETE
  })
]);

function fail(code: D1RetentionMaintenanceErrorCode): never {
  throw new D1RetentionMaintenanceError(code);
}

function validLimit(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= MIN_MAX_RECORDS &&
    value <= MAX_MAX_RECORDS
  );
}

function canonicalCutoff(now: () => Date): string {
  let value: Date;
  try {
    value = now();
  } catch {
    return fail("SERVICE_UNAVAILABLE");
  }
  const milliseconds = value instanceof Date ? value.getTime() : Number.NaN;
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds < Date.parse("2020-01-01T00:00:00.000Z") ||
    milliseconds >= Date.parse("2100-01-01T00:00:00.000Z")
  ) {
    return fail("SERVICE_UNAVAILABLE");
  }
  return new Date(milliseconds).toISOString();
}

function emptyCounts(): Record<RetentionCountKey, number> {
  return {
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
  };
}

function freezeCounts(
  counts: Readonly<Record<RetentionCountKey, number>>
): D1RetentionDeletionCounts {
  return Object.freeze({ ...counts });
}

function resultChanges(
  result: D1MutationResultLike | undefined,
  limit: number
): number {
  const changes = result?.meta?.changes;
  if (
    result?.success !== true ||
    !Number.isSafeInteger(changes) ||
    changes === undefined ||
    changes < 0 ||
    changes > limit
  ) {
    return fail("SERVICE_UNAVAILABLE");
  }
  return changes;
}

async function runPlan(
  db: D1RetentionDatabaseLike,
  plan: CleanupPlan,
  cutoff: string,
  limit: number
): Promise<number> {
  const statements: D1MutationPreparedStatementLike[] = [];
  if (plan.dirtySql !== undefined) {
    statements.push(db.prepare(plan.dirtySql).bind(cutoff));
  }
  statements.push(db.prepare(plan.deleteSql).bind(cutoff, limit));
  let results: readonly D1MutationResultLike[];
  try {
    results = await db.batch(statements);
  } catch {
    return fail("SERVICE_UNAVAILABLE");
  }
  if (results.length !== statements.length) return fail("SERVICE_UNAVAILABLE");
  if (
    plan.dirtySql !== undefined &&
    results[0]?.success !== true
  ) {
    return fail("SERVICE_UNAVAILABLE");
  }
  return resultChanges(results.at(-1), limit);
}

/**
 * Creates the narrow storage boundary used by scheduled retention work. Each
 * fixed DELETE chooses and rechecks its own expiry predicate atomically. Public
 * truth invalidation shares the same D1 batch as usage-affecting deletes.
 */
export function createD1RetentionMaintenanceStorage(
  db: D1RetentionDatabaseLike,
  options: D1RetentionMaintenanceStorageOptions = {}
): D1RetentionMaintenanceStoragePort {
  if (
    db === null ||
    typeof db !== "object" ||
    typeof db.prepare !== "function" ||
    typeof db.batch !== "function" ||
    options === null ||
    typeof options !== "object" ||
    (options.preserveCompactionInputs !== undefined &&
      typeof options.preserveCompactionInputs !== "boolean")
  ) {
    fail("INPUT_INVALID");
  }
  const cleanupPlans = options.preserveCompactionInputs === true
    ? CLEANUP_PLANS.filter(
        ({ countKey }) =>
          countKey !== "usageBuckets" && countKey !== "authorityBindings"
      )
    : CLEANUP_PLANS;

  return Object.freeze({
    async deleteExpiredRecords(
      input: Readonly<{ cutoff: string; maxRecords: number }>
    ): Promise<D1RetentionDeletionCounts> {
      if (
        input === null ||
        typeof input !== "object" ||
        typeof input.cutoff !== "string" ||
        !/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(
          input.cutoff
        ) ||
        !Number.isFinite(Date.parse(input.cutoff)) ||
        new Date(Date.parse(input.cutoff)).toISOString() !== input.cutoff ||
        Date.parse(input.cutoff) < Date.parse("2020-01-01T00:00:00.000Z") ||
        Date.parse(input.cutoff) >= Date.parse("2100-01-01T00:00:00.000Z") ||
        !validLimit(input.maxRecords)
      ) {
        return fail("INPUT_INVALID");
      }

      const counts = emptyCounts();
      let remaining = input.maxRecords;
      const fairShare = Math.floor(input.maxRecords / cleanupPlans.length);
      try {
        for (const plan of cleanupPlans) {
          const changed = await runPlan(
            db,
            plan,
            input.cutoff,
            Math.min(fairShare, remaining)
          );
          counts[plan.countKey] += changed;
          remaining -= changed;
        }

        // A second pass consumes unused fair-share capacity without starving
        // later TTL classes. It is still at most one extra fixed batch/table.
        for (const plan of cleanupPlans) {
          if (remaining === 0) break;
          const changed = await runPlan(
            db,
            plan,
            input.cutoff,
            remaining
          );
          counts[plan.countKey] += changed;
          remaining -= changed;
        }
      } catch (error: unknown) {
        if (error instanceof D1RetentionMaintenanceError) throw error;
        return fail("SERVICE_UNAVAILABLE");
      }
      return freezeCounts(counts);
    }
  });
}

function validateCounts(
  value: D1RetentionDeletionCounts,
  maxRecords: number
): number {
  if (value === null || typeof value !== "object") {
    return fail("SERVICE_UNAVAILABLE");
  }
  let total = 0;
  for (const key of COUNT_KEYS) {
    const count = value[key];
    if (!Number.isSafeInteger(count) || count < 0 || count > maxRecords) {
      return fail("SERVICE_UNAVAILABLE");
    }
    total += count;
  }
  if (!Number.isSafeInteger(total) || total > maxRecords) {
    return fail("SERVICE_UNAVAILABLE");
  }
  return total;
}

/** Runs one bounded hard-retention page and returns only aggregate counts. */
export function createD1RetentionMaintenanceProcessor(
  storage: D1RetentionMaintenanceStoragePort,
  options: D1RetentionMaintenanceOptions = {}
): D1RetentionMaintenanceProcessor {
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  if (
    storage === null ||
    typeof storage !== "object" ||
    typeof storage.deleteExpiredRecords !== "function" ||
    !validLimit(maxRecords)
  ) {
    fail("INPUT_INVALID");
  }
  const now = options.now ?? (() => new Date());

  return async () => {
    const cutoff = canonicalCutoff(now);
    try {
      const counts = await storage.deleteExpiredRecords({
        cutoff,
        maxRecords
      });
      const deletedRecords = validateCounts(counts, maxRecords);
      const frozenCounts = freezeCounts(counts);
      return Object.freeze({
        deletedRecords,
        projectionInvalidated:
          frozenCounts.usageBuckets > 0 ||
          frozenCounts.authorityBindings > 0 ||
          frozenCounts.installationTombstones > 0,
        counts: frozenCounts
      });
    } catch (error: unknown) {
      if (error instanceof D1RetentionMaintenanceError) throw error;
      return fail("SERVICE_UNAVAILABLE");
    }
  };
}
