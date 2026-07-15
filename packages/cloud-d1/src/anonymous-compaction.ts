import type {
  D1MutationDatabaseLike,
  D1MutationPreparedStatementLike,
  D1MutationResultLike,
  D1MutationSessionLike
} from "./mutation-storage.js";

const COMPACTION_VERSION = "day-all-v1";
const MINIMUM_COHORT = 20;
// Every wire token component is at most Number.MAX_SAFE_INTEGER. Keeping a
// complete day at or below 800 rows proves every SQL SUM remains below the
// public 80%-of-int64 safety ceiling without using floating point. Larger
// days are privacy-dropped atomically and become an explicit capacity signal.
const MAX_ROLLUP_INPUT_ROWS = 800;
const MAX_PUBLIC_TOTAL = 7_378_697_629_483_820_645n;
const MAX_SQLITE_INTEGER = 9_223_372_036_854_775_807n;
const DAY_MS = 86_400_000;
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;

type UnknownRow = Readonly<Record<string, unknown>>;

const NEXT_COMPLETE_EXPIRED_DAY = `SELECT bucket_start AS bucketStart
FROM usage_daily_current
GROUP BY bucket_start
HAVING count(*) > 0
  AND date(bucket_start, '+1 day') <= date(?1)
  AND max(expires_at) <= ?1
ORDER BY bucket_start
LIMIT 1`;

const SOURCE_COUNTS = `WITH eligible_installations AS (
  SELECT DISTINCT usage.installation_id
  FROM usage_daily_current AS usage
  JOIN installations AS installation
    ON installation.installation_id = usage.installation_id
  WHERE usage.bucket_start = ?1
    AND usage.quarantine_status = 'accepted'
    AND usage.total_tokens > 0
    AND installation.status IN ('active', 'paused')
)
SELECT
  count(*) AS inputRowCount,
  sum(CASE WHEN expires_at <= ?2 THEN 1 ELSE 0 END) AS expiredRowCount,
  (SELECT count(*) FROM eligible_installations) AS eligibleCohortCount
FROM usage_daily_current
WHERE bucket_start = ?1`;

const ROLLUP_STATS = `WITH
  eligible_installations AS (
    SELECT DISTINCT usage.installation_id
    FROM usage_daily_current AS usage
    JOIN installations AS installation
      ON installation.installation_id = usage.installation_id
    WHERE usage.bucket_start = ?1
      AND usage.quarantine_status = 'accepted'
      AND usage.total_tokens > 0
      AND installation.status IN ('active', 'paused')
  ),
  selected_installations AS (
    SELECT DISTINCT installation_id
    FROM usage_daily_current
    WHERE bucket_start = ?1
  )
SELECT
  cast(coalesce(sum(CASE
    WHEN eligible.installation_id IS NOT NULL
      AND usage.quarantine_status = 'accepted'
    THEN usage.input_tokens ELSE 0 END), 0) AS TEXT) AS inputTokens,
  cast(coalesce(sum(CASE
    WHEN eligible.installation_id IS NOT NULL
      AND usage.quarantine_status = 'accepted'
    THEN usage.output_tokens ELSE 0 END), 0) AS TEXT) AS outputTokens,
  cast(coalesce(sum(CASE
    WHEN eligible.installation_id IS NOT NULL
      AND usage.quarantine_status = 'accepted'
    THEN usage.cache_read_tokens ELSE 0 END), 0) AS TEXT) AS cacheReadTokens,
  cast(coalesce(sum(CASE
    WHEN eligible.installation_id IS NOT NULL
      AND usage.quarantine_status = 'accepted'
    THEN usage.cache_write_tokens ELSE 0 END), 0) AS TEXT) AS cacheWriteTokens,
  cast(coalesce(sum(CASE
    WHEN eligible.installation_id IS NOT NULL
      AND usage.quarantine_status = 'accepted'
    THEN usage.reasoning_tokens ELSE 0 END), 0) AS TEXT) AS reasoningTokens,
  cast(coalesce(sum(CASE
    WHEN eligible.installation_id IS NOT NULL
      AND usage.quarantine_status = 'accepted'
    THEN usage.other_tokens ELSE 0 END), 0) AS TEXT) AS otherTokens,
  cast(coalesce(sum(CASE
    WHEN eligible.installation_id IS NOT NULL
      AND usage.quarantine_status = 'accepted'
    THEN usage.total_tokens ELSE 0 END), 0) AS TEXT) AS totalTokens,
  (SELECT count(*) FROM collector_window_bindings
    WHERE bucket_start = ?1) AS deletedBindingCount,
  (SELECT count(*)
    FROM quarantine_events AS quarantine
    WHERE quarantine.expires_at <= ?2
      AND quarantine.installation_id IN (
        SELECT installation_id FROM selected_installations
      )) AS deletedQuarantineEventCount,
  (SELECT count(*)
    FROM ingest_batches AS batch
    WHERE batch.expires_at <= ?2
      AND batch.installation_id IN (
        SELECT installation_id FROM selected_installations
      )
      AND NOT EXISTS (
        SELECT 1 FROM quarantine_events AS quarantine
        WHERE quarantine.installation_id = batch.installation_id
          AND quarantine.batch_id = batch.batch_id
          AND quarantine.expires_at > ?2
      )) AS deletedBatchReceiptCount,
  cast(coalesce((SELECT sum(total_tokens) FROM anonymous_rollups), 0) AS TEXT)
    AS historicalTokens
FROM usage_daily_current AS usage
LEFT JOIN eligible_installations AS eligible
  ON eligible.installation_id = usage.installation_id
WHERE usage.bucket_start = ?1`;

const ROLLED_RUN_INSERT = `WITH
  eligible_installations AS (
    SELECT DISTINCT usage.installation_id
    FROM usage_daily_current AS usage
    JOIN installations AS installation
      ON installation.installation_id = usage.installation_id
    WHERE usage.bucket_start = ?2
      AND usage.quarantine_status = 'accepted'
      AND usage.total_tokens > 0
      AND installation.status IN ('active', 'paused')
  ),
  selected_installations AS (
    SELECT DISTINCT installation_id
    FROM usage_daily_current
    WHERE bucket_start = ?2
  ),
  stats AS (
    SELECT
      count(*) AS input_row_count,
      sum(CASE WHEN usage.expires_at <= ?5 THEN 1 ELSE 0 END)
        AS expired_row_count,
      cast(coalesce(sum(CASE
        WHEN eligible.installation_id IS NOT NULL
          AND usage.quarantine_status = 'accepted'
        THEN usage.input_tokens ELSE 0 END), 0) AS TEXT) AS input_tokens,
      cast(coalesce(sum(CASE
        WHEN eligible.installation_id IS NOT NULL
          AND usage.quarantine_status = 'accepted'
        THEN usage.output_tokens ELSE 0 END), 0) AS TEXT) AS output_tokens,
      cast(coalesce(sum(CASE
        WHEN eligible.installation_id IS NOT NULL
          AND usage.quarantine_status = 'accepted'
        THEN usage.cache_read_tokens ELSE 0 END), 0) AS TEXT)
        AS cache_read_tokens,
      cast(coalesce(sum(CASE
        WHEN eligible.installation_id IS NOT NULL
          AND usage.quarantine_status = 'accepted'
        THEN usage.cache_write_tokens ELSE 0 END), 0) AS TEXT)
        AS cache_write_tokens,
      cast(coalesce(sum(CASE
        WHEN eligible.installation_id IS NOT NULL
          AND usage.quarantine_status = 'accepted'
        THEN usage.reasoning_tokens ELSE 0 END), 0) AS TEXT)
        AS reasoning_tokens,
      cast(coalesce(sum(CASE
        WHEN eligible.installation_id IS NOT NULL
          AND usage.quarantine_status = 'accepted'
        THEN usage.other_tokens ELSE 0 END), 0) AS TEXT) AS other_tokens,
      cast(coalesce(sum(CASE
        WHEN eligible.installation_id IS NOT NULL
          AND usage.quarantine_status = 'accepted'
        THEN usage.total_tokens ELSE 0 END), 0) AS TEXT) AS total_tokens,
      (SELECT count(*) FROM eligible_installations) AS eligible_count,
      (SELECT count(*) FROM collector_window_bindings
        WHERE bucket_start = ?2) AS binding_count,
      (SELECT count(*) FROM quarantine_events AS quarantine
        WHERE quarantine.expires_at <= ?5
          AND quarantine.installation_id IN (
            SELECT installation_id FROM selected_installations
          )) AS quarantine_count,
      (SELECT count(*) FROM ingest_batches AS batch
        WHERE batch.expires_at <= ?5
          AND batch.installation_id IN (
            SELECT installation_id FROM selected_installations
          )
          AND NOT EXISTS (
            SELECT 1 FROM quarantine_events AS quarantine
            WHERE quarantine.installation_id = batch.installation_id
              AND quarantine.batch_id = batch.batch_id
              AND quarantine.expires_at > ?5
          )) AS batch_count
    FROM usage_daily_current AS usage
    LEFT JOIN eligible_installations AS eligible
      ON eligible.installation_id = usage.installation_id
    WHERE usage.bucket_start = ?2
  )
INSERT INTO compaction_runs (
  run_id, period_start, period_end, compaction_version, status,
  input_row_count, output_row_count, eligible_cohort_count, k_gate_result,
  checksum, started_at, finished_at, deleted_binding_count,
  deleted_batch_receipt_count, deleted_quarantine_event_count, input_tokens,
  output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
  other_tokens, total_tokens
)
SELECT
  ?1, ?3, ?4, '${COMPACTION_VERSION}', 'completed', ?6, 1, ?7,
  'rolled_up', ?18, ?19, ?19, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
  ?16, ?17
FROM stats
WHERE stats.input_row_count = ?6
  AND stats.expired_row_count = ?6
  AND stats.input_row_count BETWEEN 1 AND ${MAX_ROLLUP_INPUT_ROWS}
  AND stats.eligible_count = ?7
  AND stats.binding_count = ?8
  AND stats.batch_count = ?9
  AND stats.quarantine_count = ?10
  AND stats.input_tokens = ?11
  AND stats.output_tokens = ?12
  AND stats.cache_read_tokens = ?13
  AND stats.cache_write_tokens = ?14
  AND stats.reasoning_tokens = ?15
  AND stats.other_tokens = ?16
  AND stats.total_tokens = ?17
  AND NOT EXISTS (
    SELECT 1 FROM compaction_runs
    WHERE period_start = ?3 AND compaction_version = '${COMPACTION_VERSION}'
  )
  AND coalesce((SELECT sum(total_tokens) FROM anonymous_rollups), 0)
    <= cast(?20 AS INTEGER)`;

const DROPPED_RUN_INSERT = `WITH eligible_installations AS (
  SELECT DISTINCT usage.installation_id
  FROM usage_daily_current AS usage
  JOIN installations AS installation
    ON installation.installation_id = usage.installation_id
  WHERE usage.bucket_start = ?2
    AND usage.quarantine_status = 'accepted'
    AND usage.total_tokens > 0
    AND installation.status IN ('active', 'paused')
), stats AS (
  SELECT
    count(*) AS input_row_count,
    sum(CASE WHEN expires_at <= ?5 THEN 1 ELSE 0 END) AS expired_row_count,
    (SELECT count(*) FROM eligible_installations) AS eligible_count
  FROM usage_daily_current
  WHERE bucket_start = ?2
)
INSERT INTO compaction_runs (
  run_id, period_start, period_end, compaction_version, status,
  input_row_count, output_row_count, eligible_cohort_count, k_gate_result,
  checksum, started_at, finished_at
)
SELECT ?1, ?3, ?4, '${COMPACTION_VERSION}', 'completed', ?6, 0, ?7,
  'dropped', ?8, ?9, ?9
FROM stats
WHERE stats.input_row_count = ?6
  AND stats.expired_row_count = ?6
  AND stats.input_row_count > 0
  AND stats.eligible_count = ?7
  AND NOT EXISTS (
    SELECT 1 FROM compaction_runs
    WHERE period_start = ?3 AND compaction_version = '${COMPACTION_VERSION}'
  )
  AND NOT EXISTS (
    SELECT 1 FROM anonymous_rollups
    WHERE period_start = ?3 AND compaction_version = '${COMPACTION_VERSION}'
  )`;

const ROLLUP_INSERT = `INSERT INTO anonymous_rollups (
  period_start, period_end, scope, provider, model_family, tool,
  compaction_version, eligible_cohort_count, input_tokens, output_tokens,
  cache_read_tokens, cache_write_tokens, reasoning_tokens, other_tokens,
  total_tokens, created_at
)
SELECT ?2, ?3, 'all', 'other', 'all', 'all', '${COMPACTION_VERSION}', ?4,
  ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
FROM compaction_runs
WHERE run_id = ?1 AND status = 'completed' AND k_gate_result = 'rolled_up'`;

const QUARANTINE_DELETE = `DELETE FROM quarantine_events
WHERE expires_at <= ?3
  AND installation_id IN (
    SELECT installation_id FROM usage_daily_current WHERE bucket_start = ?2
  )
  AND EXISTS (SELECT 1 FROM compaction_runs WHERE run_id = ?1)`;

const BATCH_DELETE = `DELETE FROM ingest_batches AS batch
WHERE batch.expires_at <= ?3
  AND batch.installation_id IN (
    SELECT installation_id FROM usage_daily_current WHERE bucket_start = ?2
  )
  AND NOT EXISTS (
    SELECT 1 FROM quarantine_events AS quarantine
    WHERE quarantine.installation_id = batch.installation_id
      AND quarantine.batch_id = batch.batch_id
  )
  AND EXISTS (SELECT 1 FROM compaction_runs WHERE run_id = ?1)`;

const USAGE_DELETE = `DELETE FROM usage_daily_current
WHERE bucket_start = ?2
  AND EXISTS (SELECT 1 FROM compaction_runs WHERE run_id = ?1)`;

const BINDING_DELETE = `DELETE FROM collector_window_bindings AS binding
WHERE binding.bucket_start = ?2
  AND NOT EXISTS (
    SELECT 1 FROM usage_daily_current AS usage
    WHERE usage.installation_id = binding.installation_id
      AND usage.bucket_start = binding.bucket_start
  )
  AND EXISTS (SELECT 1 FROM compaction_runs WHERE run_id = ?1)`;

const DIRTY_UPSERT = `INSERT INTO aggregate_dirty (
  singleton_key, dirty_since, reason, dirty_revision
)
SELECT 1, ?2, 'compaction', 1
WHERE EXISTS (SELECT 1 FROM compaction_runs WHERE run_id = ?1)
ON CONFLICT (singleton_key) DO UPDATE SET
  dirty_since = CASE
    WHEN excluded.dirty_since < aggregate_dirty.dirty_since
      THEN excluded.dirty_since
    ELSE aggregate_dirty.dirty_since
  END,
  reason = excluded.reason,
  dirty_revision = aggregate_dirty.dirty_revision + 1`;

export type D1AnonymousCompactionErrorCode =
  | "INPUT_INVALID"
  | "STALE_PREFLIGHT"
  | "SERVICE_UNAVAILABLE";

export class D1AnonymousCompactionError extends Error {
  override readonly name = "D1AnonymousCompactionError";

  constructor(readonly code: D1AnonymousCompactionErrorCode) {
    super(
      code === "INPUT_INVALID"
        ? "The anonymous compactor received invalid input."
        : code === "STALE_PREFLIGHT"
          ? "The anonymous compaction input changed before commit."
          : "The anonymous compaction service is unavailable."
    );
  }

  toJSON(): Readonly<{
    name: "D1AnonymousCompactionError";
    code: D1AnonymousCompactionErrorCode;
  }> {
    return Object.freeze({ name: this.name, code: this.code });
  }
}

export interface D1AnonymousCompactionOptions {
  /** Dependency injection exists for deterministic scheduled tests only. */
  readonly now?: () => Date;
  /** Must return a fresh opaque, content-free run identifier. */
  readonly createRunId?: () => string;
}

export interface D1AnonymousCompactionResult {
  readonly status: "idle" | "rolled-up" | "dropped";
  readonly periodStart: string | null;
  readonly inputRows: number;
  readonly eligibleCohortCount: number;
  readonly outputRows: 0 | 1;
}

export type D1AnonymousCompactionProcessor =
  () => Promise<D1AnonymousCompactionResult>;

interface SourceCounts {
  readonly inputRows: number;
  readonly expiredRows: number;
  readonly eligibleCohortCount: number;
}

interface RollupStats {
  readonly inputTokens: string;
  readonly outputTokens: string;
  readonly cacheReadTokens: string;
  readonly cacheWriteTokens: string;
  readonly reasoningTokens: string;
  readonly otherTokens: string;
  readonly totalTokens: string;
  readonly deletedBindingCount: number;
  readonly deletedBatchReceiptCount: number;
  readonly deletedQuarantineEventCount: number;
  readonly historicalTokens: string;
}

function fail(code: D1AnonymousCompactionErrorCode): never {
  throw new D1AnonymousCompactionError(code);
}

function canonicalNow(now: () => Date): string {
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

function defaultRunId(): string {
  try {
    return `cmp_${crypto.randomUUID()}`;
  } catch {
    return fail("SERVICE_UNAVAILABLE");
  }
}

function runId(createRunId: () => string): string {
  let value: string;
  try {
    value = createRunId();
  } catch {
    return fail("SERVICE_UNAVAILABLE");
  }
  if (!RUN_ID_PATTERN.test(value)) return fail("SERVICE_UNAVAILABLE");
  return value;
}

function safeCount(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^(?:0|[1-9][0-9]{0,15})$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return fail("SERVICE_UNAVAILABLE");
}

function token(value: unknown): string {
  const canonical =
    typeof value === "string"
      ? value
      : typeof value === "number" && Number.isSafeInteger(value)
        ? String(value)
        : "";
  if (!/^(?:0|[1-9][0-9]{0,18})$/u.test(canonical)) {
    return fail("SERVICE_UNAVAILABLE");
  }
  const parsed = BigInt(canonical);
  if (parsed > MAX_SQLITE_INTEGER) return fail("SERVICE_UNAVAILABLE");
  return canonical;
}

function period(bucketStart: unknown): Readonly<{
  bucketStart: string;
  periodStart: string;
  periodEnd: string;
}> {
  if (
    typeof bucketStart !== "string" ||
    !/^20[2-9][0-9]-[0-1][0-9]-[0-3][0-9]T00:00:00\.000Z$/u.test(
      bucketStart
    ) ||
    !Number.isFinite(Date.parse(bucketStart)) ||
    new Date(Date.parse(bucketStart)).toISOString() !== bucketStart
  ) {
    return fail("SERVICE_UNAVAILABLE");
  }
  return Object.freeze({
    bucketStart,
    periodStart: bucketStart.slice(0, 10),
    periodEnd: new Date(Date.parse(bucketStart) + DAY_MS)
      .toISOString()
      .slice(0, 10)
  });
}

async function first(
  session: D1MutationSessionLike,
  query: string,
  bindings: readonly (null | number | string | ArrayBuffer)[]
): Promise<UnknownRow | null> {
  try {
    return await session.prepare(query).bind(...bindings).first<UnknownRow>();
  } catch {
    return fail("SERVICE_UNAVAILABLE");
  }
}

async function checksum(value: string): Promise<ArrayBuffer> {
  try {
    return await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  } catch {
    return fail("SERVICE_UNAVAILABLE");
  }
}

function sourceCounts(row: UnknownRow | null): SourceCounts {
  if (row === null) return fail("SERVICE_UNAVAILABLE");
  return Object.freeze({
    inputRows: safeCount(row["inputRowCount"]),
    expiredRows: safeCount(row["expiredRowCount"]),
    eligibleCohortCount: safeCount(row["eligibleCohortCount"])
  });
}

function rollupStats(row: UnknownRow | null): RollupStats {
  if (row === null) return fail("SERVICE_UNAVAILABLE");
  const parsed = Object.freeze({
    inputTokens: token(row["inputTokens"]),
    outputTokens: token(row["outputTokens"]),
    cacheReadTokens: token(row["cacheReadTokens"]),
    cacheWriteTokens: token(row["cacheWriteTokens"]),
    reasoningTokens: token(row["reasoningTokens"]),
    otherTokens: token(row["otherTokens"]),
    totalTokens: token(row["totalTokens"]),
    deletedBindingCount: safeCount(row["deletedBindingCount"]),
    deletedBatchReceiptCount: safeCount(row["deletedBatchReceiptCount"]),
    deletedQuarantineEventCount: safeCount(
      row["deletedQuarantineEventCount"]
    ),
    historicalTokens: token(row["historicalTokens"])
  });
  if (
    BigInt(parsed.reasoningTokens) > BigInt(parsed.outputTokens) ||
    BigInt(parsed.totalTokens) !==
      BigInt(parsed.inputTokens) +
        BigInt(parsed.outputTokens) +
        BigInt(parsed.cacheReadTokens) +
        BigInt(parsed.cacheWriteTokens) +
        BigInt(parsed.otherTokens)
  ) {
    return fail("SERVICE_UNAVAILABLE");
  }
  return parsed;
}

function cleanupStatements(
  db: D1MutationDatabaseLike,
  id: string,
  bucketStart: string,
  cutoff: string
): D1MutationPreparedStatementLike[] {
  return [
    db.prepare(QUARANTINE_DELETE).bind(id, bucketStart, cutoff),
    db.prepare(BATCH_DELETE).bind(id, bucketStart, cutoff),
    db.prepare(USAGE_DELETE).bind(id, bucketStart),
    db.prepare(BINDING_DELETE).bind(id, bucketStart),
    db.prepare(DIRTY_UPSERT).bind(id, cutoff)
  ];
}

async function commit(
  db: D1MutationDatabaseLike,
  statements: D1MutationPreparedStatementLike[],
  expectRollup: boolean
): Promise<void> {
  let results: readonly D1MutationResultLike[];
  try {
    results = await db.batch(statements);
  } catch {
    return fail("SERVICE_UNAVAILABLE");
  }
  if (
    results.length !== statements.length ||
    results.some(({ success }) => success !== true)
  ) {
    return fail("SERVICE_UNAVAILABLE");
  }
  if (results[0]?.meta?.changes !== 1) return fail("STALE_PREFLIGHT");
  if (expectRollup && results[1]?.meta?.changes !== 1) {
    return fail("SERVICE_UNAVAILABLE");
  }
}

function idle(): D1AnonymousCompactionResult {
  return Object.freeze({
    status: "idle" as const,
    periodStart: null,
    inputRows: 0,
    eligibleCohortCount: 0,
    outputRows: 0 as const
  });
}

export function createD1AnonymousCompactionProcessor(
  db: D1MutationDatabaseLike,
  options: D1AnonymousCompactionOptions = {}
): D1AnonymousCompactionProcessor {
  if (
    db === null ||
    typeof db !== "object" ||
    typeof db.prepare !== "function" ||
    typeof db.batch !== "function" ||
    typeof db.withSession !== "function" ||
    options === null ||
    typeof options !== "object"
  ) {
    fail("INPUT_INVALID");
  }
  const now = options.now ?? (() => new Date());
  const createRunId = options.createRunId ?? defaultRunId;

  return async (): Promise<D1AnonymousCompactionResult> => {
    const cutoff = canonicalNow(now);
    let session: D1MutationSessionLike;
    try {
      session = db.withSession("first-primary");
    } catch {
      return fail("SERVICE_UNAVAILABLE");
    }
    const candidate = await first(session, NEXT_COMPLETE_EXPIRED_DAY, [cutoff]);
    if (candidate === null) return idle();
    const selected = period(candidate["bucketStart"]);
    const counts = sourceCounts(
      await first(session, SOURCE_COUNTS, [selected.bucketStart, cutoff])
    );
    if (counts.inputRows === 0 || counts.inputRows !== counts.expiredRows) {
      return fail("STALE_PREFLIGHT");
    }
    const id = runId(createRunId);
    const dropForCohort = counts.eligibleCohortCount < MINIMUM_COHORT;
    const dropForCapacity = counts.inputRows > MAX_ROLLUP_INPUT_ROWS;

    if (dropForCohort || dropForCapacity) {
      const digest = await checksum(
        [
          COMPACTION_VERSION,
          "dropped",
          selected.periodStart,
          selected.periodEnd,
          String(counts.inputRows),
          String(counts.eligibleCohortCount)
        ].join("|")
      );
      const statements = [
        db.prepare(DROPPED_RUN_INSERT).bind(
          id,
          selected.bucketStart,
          selected.periodStart,
          selected.periodEnd,
          cutoff,
          counts.inputRows,
          counts.eligibleCohortCount,
          digest,
          cutoff
        ),
        ...cleanupStatements(db, id, selected.bucketStart, cutoff)
      ];
      await commit(db, statements, false);
      return Object.freeze({
        status: "dropped" as const,
        periodStart: selected.periodStart,
        inputRows: counts.inputRows,
        eligibleCohortCount: counts.eligibleCohortCount,
        outputRows: 0 as const
      });
    }

    const stats = rollupStats(
      await first(session, ROLLUP_STATS, [selected.bucketStart, cutoff])
    );
    const newTotal = BigInt(stats.totalTokens);
    const historical = BigInt(stats.historicalTokens);
    if (
      newTotal > MAX_PUBLIC_TOTAL ||
      historical > MAX_PUBLIC_TOTAL ||
      historical + newTotal > MAX_PUBLIC_TOTAL
    ) {
      const digest = await checksum(
        [
          COMPACTION_VERSION,
          "dropped",
          selected.periodStart,
          selected.periodEnd,
          String(counts.inputRows),
          String(counts.eligibleCohortCount)
        ].join("|")
      );
      const statements = [
        db.prepare(DROPPED_RUN_INSERT).bind(
          id,
          selected.bucketStart,
          selected.periodStart,
          selected.periodEnd,
          cutoff,
          counts.inputRows,
          counts.eligibleCohortCount,
          digest,
          cutoff
        ),
        ...cleanupStatements(db, id, selected.bucketStart, cutoff)
      ];
      await commit(db, statements, false);
      return Object.freeze({
        status: "dropped" as const,
        periodStart: selected.periodStart,
        inputRows: counts.inputRows,
        eligibleCohortCount: counts.eligibleCohortCount,
        outputRows: 0 as const
      });
    }

    const digest = await checksum(
      [
        COMPACTION_VERSION,
        "rolled_up",
        selected.periodStart,
        selected.periodEnd,
        String(counts.inputRows),
        String(counts.eligibleCohortCount),
        stats.inputTokens,
        stats.outputTokens,
        stats.cacheReadTokens,
        stats.cacheWriteTokens,
        stats.reasoningTokens,
        stats.otherTokens,
        stats.totalTokens
      ].join("|")
    );
    const remainingCapacity = (MAX_PUBLIC_TOTAL - newTotal).toString();
    const statements = [
      db.prepare(ROLLED_RUN_INSERT).bind(
        id,
        selected.bucketStart,
        selected.periodStart,
        selected.periodEnd,
        cutoff,
        counts.inputRows,
        counts.eligibleCohortCount,
        stats.deletedBindingCount,
        stats.deletedBatchReceiptCount,
        stats.deletedQuarantineEventCount,
        stats.inputTokens,
        stats.outputTokens,
        stats.cacheReadTokens,
        stats.cacheWriteTokens,
        stats.reasoningTokens,
        stats.otherTokens,
        stats.totalTokens,
        digest,
        cutoff,
        remainingCapacity
      ),
      db.prepare(ROLLUP_INSERT).bind(
        id,
        selected.periodStart,
        selected.periodEnd,
        counts.eligibleCohortCount,
        stats.inputTokens,
        stats.outputTokens,
        stats.cacheReadTokens,
        stats.cacheWriteTokens,
        stats.reasoningTokens,
        stats.otherTokens,
        stats.totalTokens,
        cutoff
      ),
      ...cleanupStatements(db, id, selected.bucketStart, cutoff)
    ];
    await commit(db, statements, true);
    return Object.freeze({
      status: "rolled-up" as const,
      periodStart: selected.periodStart,
      inputRows: counts.inputRows,
      eligibleCohortCount: counts.eligibleCohortCount,
      outputRows: 1 as const
    });
  };
}
