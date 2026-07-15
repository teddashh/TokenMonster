import type {
  D1MutationDatabaseLike,
  D1MutationPreparedStatementLike
} from "./mutation-storage.js";
import {
  createD1PublicTotalsReader,
  type PublicTotalsSnapshot
} from "./public-totals-reader.js";

// Stop well before SQLite's signed-int64 ceiling. The remaining headroom is
// reserved for a safe operator response and a reviewed aggregation migration.
const MAX_PUBLIC_TOTAL = "7378697629483820645";
const REVISION_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u;

const REBUILD_PUBLIC_TOTALS = `WITH
  current_totals AS (
    SELECT
      coalesce(sum(total_tokens), 0) AS all_tokens,
      coalesce(sum(CASE WHEN bucket_start = ?2 THEN total_tokens ELSE 0 END), 0)
        AS today_tokens,
      count(DISTINCT CASE WHEN total_tokens > 0 THEN installation_id END)
        AS contributors
    FROM usage_daily_current
    WHERE quarantine_status = 'accepted'
      AND expires_at > ?1
      AND bucket_start <= ?2
  ),
  historical_totals AS (
    SELECT coalesce(sum(total_tokens), 0) AS all_tokens
    FROM anonymous_rollups
  ),
  candidate AS (
    SELECT
      current_totals.all_tokens + historical_totals.all_tokens AS all_tokens,
      current_totals.today_tokens AS today_tokens,
      current_totals.contributors AS contributors
    FROM current_totals CROSS JOIN historical_totals
  )
INSERT INTO public_totals_cache (
  scope,
  day_or_all,
  all_time_tokens,
  today_utc_tokens,
  contributors,
  generated_at,
  data_revision
)
SELECT
  'global',
  'all',
  cast(all_tokens AS TEXT),
  cast(today_tokens AS TEXT),
  cast(contributors AS TEXT),
  ?1,
  ?3
FROM candidate
WHERE all_tokens BETWEEN 0 AND ${MAX_PUBLIC_TOTAL}
  AND today_tokens BETWEEN 0 AND ${MAX_PUBLIC_TOTAL}
  AND contributors BETWEEN 0 AND ${MAX_PUBLIC_TOTAL}
ON CONFLICT (scope, day_or_all) DO UPDATE SET
  all_time_tokens = excluded.all_time_tokens,
  today_utc_tokens = excluded.today_utc_tokens,
  contributors = excluded.contributors,
  generated_at = excluded.generated_at,
  data_revision = excluded.data_revision`;

const CLEAR_DIRTY_FOR_REVISION = `DELETE FROM aggregate_dirty
WHERE EXISTS (
  SELECT 1
  FROM public_totals_cache
  WHERE scope = 'global'
    AND day_or_all = 'all'
    AND data_revision = ?1
)`;

export type D1PublicProjectionErrorCode =
  | "INPUT_INVALID"
  | "PROJECTION_REJECTED"
  | "SERVICE_UNAVAILABLE";

export class D1PublicProjectionError extends Error {
  override readonly name = "D1PublicProjectionError";

  constructor(readonly code: D1PublicProjectionErrorCode) {
    super(
      code === "INPUT_INVALID"
        ? "The public projection adapter received invalid input."
        : code === "PROJECTION_REJECTED"
          ? "The public projection was rejected by its safety bounds."
          : "The public projection service is unavailable."
    );
  }

  toJSON(): Readonly<{
    name: "D1PublicProjectionError";
    code: D1PublicProjectionErrorCode;
  }> {
    return Object.freeze({ name: this.name, code: this.code });
  }
}

export interface D1PublicProjectionOptions {
  readonly now?: () => Date;
  readonly createRevisionId?: () => string;
}

export type D1PublicProjectionRebuilder =
  () => Promise<PublicTotalsSnapshot>;

function fail(code: D1PublicProjectionErrorCode): never {
  throw new D1PublicProjectionError(code);
}

function canonicalNow(now: () => Date): string {
  let value: Date;
  try {
    value = now();
  } catch {
    return fail("SERVICE_UNAVAILABLE");
  }
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    return fail("SERVICE_UNAVAILABLE");
  }
  return value.toISOString();
}

function revision(createRevisionId: () => string): string {
  let id: string;
  try {
    id = createRevisionId();
  } catch {
    return fail("SERVICE_UNAVAILABLE");
  }
  if (!REVISION_ID_PATTERN.test(id)) return fail("SERVICE_UNAVAILABLE");
  return `projection-v1/${id}`;
}

function defaultRevisionId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return fail("SERVICE_UNAVAILABLE");
  }
}

async function commit(
  db: D1MutationDatabaseLike,
  statements: D1MutationPreparedStatementLike[]
): Promise<void> {
  try {
    const results = await db.batch(statements);
    if (
      results.length !== statements.length ||
      results.some(({ success }) => success !== true)
    ) {
      return fail("SERVICE_UNAVAILABLE");
    }
  } catch (error: unknown) {
    if (error instanceof D1PublicProjectionError) throw error;
    return fail("SERVICE_UNAVAILABLE");
  }
}

/**
 * Rebuilds the complete public total from canonical current rows plus
 * irreversible k-gated rollups. Both projection replacement and dirty-marker
 * cleanup happen in one D1 batch, so a concurrent accepted mutation either is
 * included or leaves the projection dirty for the next scheduled rebuild.
 */
export function createD1PublicProjectionRebuilder(
  db: D1MutationDatabaseLike,
  options: D1PublicProjectionOptions = {}
): D1PublicProjectionRebuilder {
  if (
    db === null ||
    typeof db !== "object" ||
    typeof db.prepare !== "function" ||
    typeof db.batch !== "function"
  ) {
    fail("INPUT_INVALID");
  }
  const now = options.now ?? (() => new Date());
  const createRevisionId = options.createRevisionId ?? defaultRevisionId;
  const read = createD1PublicTotalsReader(db);

  return async () => {
    const generatedAt = canonicalNow(now);
    const today = `${generatedAt.slice(0, 10)}T00:00:00.000Z`;
    const dataRevision = revision(createRevisionId);
    await commit(db, [
      db
        .prepare(REBUILD_PUBLIC_TOTALS)
        .bind(generatedAt, today, dataRevision),
      db.prepare(CLEAR_DIRTY_FOR_REVISION).bind(dataRevision)
    ]);
    let snapshot: PublicTotalsSnapshot | null;
    try {
      snapshot = await read();
    } catch {
      return fail("SERVICE_UNAVAILABLE");
    }
    if (snapshot === null || snapshot.dataRevision !== dataRevision) {
      return fail("PROJECTION_REJECTED");
    }
    return snapshot;
  };
}
