import { z } from "zod";

export const INGEST_SNAPSHOT_V1_SCHEMA_VERSION = "1" as const;
export const MAX_TOKEN_COUNT_V1 = "9007199254740991" as const;
export const MAX_TOKEN_DECIMAL_DIGITS = MAX_TOKEN_COUNT_V1.length;
export const MAX_INGEST_BUCKETS_V1 = 30;

const MIN_REASONABLE_TIMESTAMP_MS = Date.parse("2020-01-01T00:00:00.000Z");
const MAX_REASONABLE_TIMESTAMP_MS = Date.parse("2100-01-01T00:00:00.000Z");

const UTC_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{3}))?Z$/;
const UTC_DAILY_BUCKET_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T00:00:00\.000Z$/;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const NORMALIZED_PUBLIC_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const DECIMAL_TOKEN_PATTERN = new RegExp(
  "^(?:0|[1-9][0-9]{0," + String(MAX_TOKEN_DECIMAL_DIGITS - 1) + "})$"
);

function isReasonableUtcTimestamp(value: string): boolean {
  const match = UTC_TIMESTAMP_PATTERN.exec(value);
  if (match === null) {
    return false;
  }

  const milliseconds = match[7] ?? "000";
  const canonical =
    value.slice(0, value.length - 1).replace(/\.\d{3}$/, "") +
    "." +
    milliseconds +
    "Z";
  const timestamp = Date.parse(canonical);

  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString() === canonical &&
    timestamp >= MIN_REASONABLE_TIMESTAMP_MS &&
    timestamp < MAX_REASONABLE_TIMESTAMP_MS
  );
}

function isReasonableUtcDailyBucket(value: string): boolean {
  if (!UTC_DAILY_BUCKET_PATTERN.test(value)) {
    return false;
  }

  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString() === value &&
    timestamp >= MIN_REASONABLE_TIMESTAMP_MS &&
    timestamp < MAX_REASONABLE_TIMESTAMP_MS
  );
}

export const DecimalTokenCountSchema = z
  .string()
  .regex(
    DECIMAL_TOKEN_PATTERN,
    "Token counts must be canonical, non-negative base-10 integer strings."
  )
  .refine(
    (count) =>
      !DECIMAL_TOKEN_PATTERN.test(count) ||
      BigInt(count) <= BigInt(MAX_TOKEN_COUNT_V1),
    "Token counts must not exceed Number.MAX_SAFE_INTEGER."
  );

export type DecimalTokenCount = z.infer<typeof DecimalTokenCountSchema>;

export const COLLECTOR_KINDS_V1 = [
  "tokscale",
  "tokentracker-bridge"
] as const;

export const CollectorKindV1Schema = z.enum(COLLECTOR_KINDS_V1);
export type CollectorKindV1 = z.infer<typeof CollectorKindV1Schema>;

export const PROVIDER_KINDS_V1 = [
  "anthropic",
  "google",
  "openai",
  "openrouter",
  "xai",
  "other"
] as const;

export const ProviderKindV1Schema = z.enum(PROVIDER_KINDS_V1);
export type ProviderKindV1 = z.infer<typeof ProviderKindV1Schema>;

export const ValueQualityV1Schema = z.enum(["exact", "estimated"]);
export type ValueQualityV1 = z.infer<typeof ValueQualityV1Schema>;

export const NormalizedPublicIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    NORMALIZED_PUBLIC_ID_PATTERN,
    "Public identifiers must be normalized lowercase slugs."
  );

export const CollectorIdentityV1Schema = z.strictObject({
  kind: CollectorKindV1Schema,
  adapterVersion: z
    .string()
    .regex(SEMVER_PATTERN, "Collector adapterVersion must be valid SemVer."),
  sourceVersion: z
    .string()
    .regex(SEMVER_PATTERN, "Collector sourceVersion must be valid SemVer.")
});

export type CollectorIdentityV1 = z.infer<typeof CollectorIdentityV1Schema>;

const TokenCountsV1BaseSchema = z.strictObject({
  input: DecimalTokenCountSchema,
  output: DecimalTokenCountSchema,
  cacheRead: DecimalTokenCountSchema,
  cacheWrite: DecimalTokenCountSchema,
  reasoning: DecimalTokenCountSchema,
  other: DecimalTokenCountSchema,
  total: DecimalTokenCountSchema
});

export type TokenCountsV1 = z.infer<typeof TokenCountsV1BaseSchema>;

const TOKEN_TOTAL_COMPONENT_FIELDS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "other"
] as const;

export function sumTokenComponentsV1(
  counts: Pick<TokenCountsV1, (typeof TOKEN_TOTAL_COMPONENT_FIELDS)[number]>
): DecimalTokenCount {
  const sum = TOKEN_TOTAL_COMPONENT_FIELDS.reduce(
    (runningTotal, field) => runningTotal + BigInt(counts[field]),
    0n
  );
  return sum.toString();
}

export function tokenTotalIsConsistentV1(counts: TokenCountsV1): boolean {
  return sumTokenComponentsV1(counts) === counts.total;
}

export const TokenCountsV1Schema = TokenCountsV1BaseSchema.superRefine(
  (counts, context) => {
    const allCountsAreCanonical = [
      ...TOKEN_TOTAL_COMPONENT_FIELDS.map((field) => counts[field]),
      counts.reasoning,
      counts.total
    ].every(
      (count) =>
        DECIMAL_TOKEN_PATTERN.test(count) &&
        BigInt(count) <= BigInt(MAX_TOKEN_COUNT_V1)
    );

    if (!allCountsAreCanonical) {
      return;
    }

    if (BigInt(counts.reasoning) > BigInt(counts.output)) {
      context.addIssue({
        code: "custom",
        path: ["reasoning"],
        message: "reasoning is informational and must be a subset of output."
      });
    }

    if (!tokenTotalIsConsistentV1(counts)) {
      context.addIssue({
        code: "custom",
        path: ["total"],
        message:
          "total must equal input + output + cacheRead + cacheWrite + other; reasoning is already included in output."
      });
    }
  }
);

export const DailyAggregateBucketV1Schema = z.strictObject({
  bucketStart: z
    .string()
    .refine(
      isReasonableUtcDailyBucket,
      "bucketStart must be a valid UTC day boundary from 2020 through 2099."
    ),
  provider: ProviderKindV1Schema,
  modelFamily: NormalizedPublicIdSchema,
  tool: NormalizedPublicIdSchema,
  valueQuality: ValueQualityV1Schema,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  tokens: TokenCountsV1Schema
});

export type DailyAggregateBucketV1 = z.infer<
  typeof DailyAggregateBucketV1Schema
>;

const IngestSnapshotV1BaseSchema = z.strictObject({
  schemaVersion: z.literal(INGEST_SNAPSHOT_V1_SCHEMA_VERSION),
  batchId: z.uuid(),
  generatedAt: z
    .string()
    .refine(
      isReasonableUtcTimestamp,
      "generatedAt must be a valid UTC timestamp from 2020 through 2099."
    ),
  collector: CollectorIdentityV1Schema,
  buckets: z
    .array(DailyAggregateBucketV1Schema)
    .min(1)
    .max(MAX_INGEST_BUCKETS_V1)
});

export const IngestSnapshotV1Schema = IngestSnapshotV1BaseSchema.superRefine(
  (snapshot, context) => {
    const seenBucketKeys = new Set<string>();

    snapshot.buckets.forEach((bucket, index) => {
      const bucketKey = [
        bucket.bucketStart,
        bucket.provider,
        bucket.modelFamily,
        bucket.tool
      ].join("|");

      if (seenBucketKeys.has(bucketKey)) {
        context.addIssue({
          code: "custom",
          path: ["buckets", index],
          message: "A snapshot cannot contain duplicate aggregate bucket keys."
        });
      }

      seenBucketKeys.add(bucketKey);
    });
  }
);

export type IngestSnapshotV1 = z.infer<typeof IngestSnapshotV1Schema>;

export function parseIngestSnapshotV1(input: unknown): IngestSnapshotV1 {
  return IngestSnapshotV1Schema.parse(input);
}

export function safeParseIngestSnapshotV1(
  input: unknown
): z.ZodSafeParseResult<IngestSnapshotV1> {
  return IngestSnapshotV1Schema.safeParse(input);
}

export function serializeIngestSnapshotV1(input: unknown): string {
  return JSON.stringify(parseIngestSnapshotV1(input));
}

export function deserializeIngestSnapshotV1(
  serialized: string
): IngestSnapshotV1 {
  const parsed: unknown = JSON.parse(serialized);
  return parseIngestSnapshotV1(parsed);
}
