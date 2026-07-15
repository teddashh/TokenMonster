import type { PublicTotalsResponse } from "@tokenmonster/api";

export const PUBLIC_COUNTER_LABEL = "TokenMonster 貢獻者已分享的 Token 總量";
export const PUBLIC_COUNTER_DISCLAIMER =
  "只包含自願匿名分享者，不代表全球所有 AI 使用量。";

const MAX_SIGNED_INT64 = 9_223_372_036_854_775_807n;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d{0,18})$/u;
const ISO_INSTANT_PATTERN =
  /^20\d{2}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?Z$/u;
export const PUBLIC_TOTALS_MAX_AGE_MS = 10 * 60 * 1_000;
const PUBLIC_TOTALS_MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const RESPONSE_FIELDS = new Set([
  "allTimeTokens",
  "contractVersion",
  "contributors",
  "dataRevision",
  "disclaimer",
  "generatedAt",
  "label",
  "todayUtcTokens",
]);

export type VerifiedPublicTotals = Readonly<PublicTotalsResponse>;

export type PublicCounterState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "unavailable" }>
  | Readonly<{ status: "verified"; snapshot: VerifiedPublicTotals }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalUnsignedInt64(value: unknown): value is string {
  return (
    typeof value === "string" &&
    DECIMAL_PATTERN.test(value) &&
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

export function parsePublicTotals(value: unknown): VerifiedPublicTotals | null {
  if (!isRecord(value)) {
    return null;
  }
  const keys = Object.keys(value);
  if (
    keys.length !== RESPONSE_FIELDS.size ||
    keys.some((key) => !RESPONSE_FIELDS.has(key))
  ) {
    return null;
  }
  if (
    value["contractVersion"] !== 1 ||
    value["label"] !== PUBLIC_COUNTER_LABEL ||
    value["disclaimer"] !== PUBLIC_COUNTER_DISCLAIMER ||
    !isCanonicalUnsignedInt64(value["allTimeTokens"]) ||
    !isCanonicalUnsignedInt64(value["todayUtcTokens"]) ||
    !isCanonicalUnsignedInt64(value["contributors"]) ||
    !isCanonicalInstant(value["generatedAt"]) ||
    typeof value["dataRevision"] !== "string" ||
    value["dataRevision"].length < 1 ||
    value["dataRevision"].length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(value["dataRevision"])
  ) {
    return null;
  }
  if (
    BigInt(value["todayUtcTokens"]) > BigInt(value["allTimeTokens"]) ||
    BigInt(value["contributors"]) > BigInt(value["allTimeTokens"])
  ) {
    return null;
  }
  return value as unknown as VerifiedPublicTotals;
}

export function publicTotalsAreFresh(
  snapshot: Pick<VerifiedPublicTotals, "generatedAt">,
  nowMs = Date.now(),
): boolean {
  const generatedAt = Date.parse(snapshot.generatedAt);
  return (
    Number.isFinite(nowMs) &&
    Number.isFinite(generatedAt) &&
    generatedAt >= nowMs - PUBLIC_TOTALS_MAX_AGE_MS &&
    generatedAt <= nowMs + PUBLIC_TOTALS_MAX_FUTURE_SKEW_MS
  );
}

export async function fetchPublicTotals(
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<VerifiedPublicTotals> {
  const response = await fetcher("/v1/public/totals", {
    method: "GET",
    headers: { Accept: "application/json" },
    credentials: "same-origin",
    referrerPolicy: "no-referrer",
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    throw new Error("Verified public totals are unavailable.");
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error("Public totals returned an unexpected content type.");
  }
  const parsed = parsePublicTotals(await response.json());
  if (parsed === null) {
    throw new Error("Public totals failed contract validation.");
  }
  if (!publicTotalsAreFresh(parsed)) {
    throw new Error("Public totals are no longer fresh.");
  }
  return parsed;
}

export function formatTokenDecimal(value: string): string {
  if (!DECIMAL_PATTERN.test(value)) {
    return "—";
  }
  return value.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

export function formatVerifiedAt(value: string): string {
  if (!isCanonicalInstant(value)) {
    return "時間未知";
  }
  return `${value.slice(0, 10)} ${value.slice(11, 19)} UTC`;
}
