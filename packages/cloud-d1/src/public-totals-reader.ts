const MAX_SIGNED_INT64 = 9_223_372_036_854_775_807n;
const CANONICAL_DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,18})$/;
const ISO_INSTANT_PATTERN =
  /^20[0-9]{2}-[0-9]{2}-[0-9]{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]{3})?Z$/;

const GLOBAL_SCOPE = "global";
const ALL_TIME_KEY = "all";
const PUBLIC_TOTALS_FIELDS = [
  "allTimeTokens",
  "contributors",
  "dataRevision",
  "generatedAt",
  "todayUtcTokens"
] as const;
const PUBLIC_TOTALS_FIELD_SET = new Set<string>(PUBLIC_TOTALS_FIELDS);

const PUBLIC_TOTALS_QUERY = `SELECT
  all_time_tokens AS allTimeTokens,
  today_utc_tokens AS todayUtcTokens,
  contributors AS contributors,
  generated_at AS generatedAt,
  data_revision AS dataRevision
FROM public_totals_cache
WHERE scope = ?1 AND day_or_all = ?2
LIMIT 1`;

export type D1BindValue = null | number | string | ArrayBuffer;

/**
 * The intentionally small structural surface used by this adapter. It keeps
 * Cloudflare globals out of packages that consume the reader.
 */
export interface D1PreparedStatementLike {
  bind(...values: readonly D1BindValue[]): D1PreparedStatementLike;
  first<T = unknown>(): Promise<T | null>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
}

/** Structurally matches the API boundary's `PublicTotalsSnapshot` port. */
export interface PublicTotalsSnapshot {
  readonly allTimeTokens: string;
  readonly todayUtcTokens: string;
  readonly contributors: string;
  readonly generatedAt: string;
  readonly dataRevision: string;
}

export type D1PublicTotalsReader = () => Promise<PublicTotalsSnapshot | null>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCanonicalUnsignedInt64(value: unknown): value is string {
  return (
    typeof value === "string" &&
    CANONICAL_DECIMAL_PATTERN.test(value) &&
    BigInt(value) <= MAX_SIGNED_INT64
  );
}

function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_INSTANT_PATTERN.test(value)) {
    return false;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return false;
  }
  const canonical = new Date(timestamp).toISOString();
  return canonical === value || canonical.replace(".000Z", "Z") === value;
}

function isDataRevision(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function parsePublicTotalsRow(value: unknown): PublicTotalsSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }

  const actualKeys = Object.keys(value);
  if (
    actualKeys.length !== PUBLIC_TOTALS_FIELDS.length ||
    actualKeys.some((key) => !PUBLIC_TOTALS_FIELD_SET.has(key)) ||
    PUBLIC_TOTALS_FIELDS.some((key) => !Object.hasOwn(value, key))
  ) {
    return null;
  }

  const allTimeTokens = value["allTimeTokens"];
  const todayUtcTokens = value["todayUtcTokens"];
  const contributors = value["contributors"];
  const generatedAt = value["generatedAt"];
  const dataRevision = value["dataRevision"];
  if (
    !isCanonicalUnsignedInt64(allTimeTokens) ||
    !isCanonicalUnsignedInt64(todayUtcTokens) ||
    !isCanonicalUnsignedInt64(contributors) ||
    !isCanonicalInstant(generatedAt) ||
    !isDataRevision(dataRevision)
  ) {
    return null;
  }
  if (
    BigInt(todayUtcTokens) > BigInt(allTimeTokens) ||
    BigInt(contributors) > BigInt(allTimeTokens)
  ) {
    return null;
  }

  return Object.freeze({
    allTimeTokens,
    todayUtcTokens,
    contributors,
    generatedAt,
    dataRevision
  });
}

/**
 * Reads the one rebuildable global public projection. Missing or malformed
 * projection rows are both treated as unavailable; the adapter never logs the
 * query or returned data.
 */
export function createD1PublicTotalsReader(
  db: D1DatabaseLike
): D1PublicTotalsReader {
  return async () => {
    const statement = db
      .prepare(PUBLIC_TOTALS_QUERY)
      .bind(GLOBAL_SCOPE, ALL_TIME_KEY);
    const row = await statement.first<unknown>();
    return parsePublicTotalsRow(row);
  };
}
