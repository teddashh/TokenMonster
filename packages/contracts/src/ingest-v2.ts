import { z } from "zod";

import {
  DailyAggregateBucketV1Schema,
  MAX_INGEST_BUCKETS_V1
} from "./ingest-v1.js";

export const INGEST_SNAPSHOT_V2_SCHEMA_VERSION = "2" as const;
export const MAX_INGEST_BUCKETS_V2 = MAX_INGEST_BUCKETS_V1;
export const COLLECTOR_KINDS_V2 = ["tokentracker-sidecar"] as const;
export const PERMANENT_SIDECAR_COLLECTOR_IDENTITY_V2 = Object.freeze({
  kind: "tokentracker-sidecar" as const,
  adapterVersion: "0.1.0" as const,
  sourceVersion: "0.80.0" as const
});

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const UTC_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{3}))?Z$/;

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
    timestamp >= Date.parse("2020-01-01T00:00:00.000Z") &&
    timestamp < Date.parse("2100-01-01T00:00:00.000Z")
  );
}

export const CollectorKindV2Schema = z.literal("tokentracker-sidecar");
export type CollectorKindV2 = z.infer<typeof CollectorKindV2Schema>;

export const CollectorIdentityV2Schema = z.strictObject({
  kind: CollectorKindV2Schema,
  adapterVersion: z
    .string()
    .regex(SEMVER_PATTERN, "Collector adapterVersion must be valid SemVer."),
  sourceVersion: z
    .string()
    .regex(SEMVER_PATTERN, "Collector sourceVersion must be valid SemVer.")
});

export type CollectorIdentityV2 = z.infer<typeof CollectorIdentityV2Schema>;

const IngestSnapshotV2BaseSchema = z.strictObject({
  schemaVersion: z.literal(INGEST_SNAPSHOT_V2_SCHEMA_VERSION),
  batchId: z.uuid(),
  generatedAt: z
    .string()
    .refine(
      isReasonableUtcTimestamp,
      "generatedAt must be a valid UTC timestamp from 2020 through 2099."
    ),
  collector: CollectorIdentityV2Schema,
  buckets: z
    .array(DailyAggregateBucketV1Schema)
    .min(1)
    .max(MAX_INGEST_BUCKETS_V2)
});

/**
 * Permanent-sidecar snapshots deliberately reuse the V1 aggregate bucket.
 * V2 changes only the collector authority carried by the envelope.
 */
export const IngestSnapshotV2Schema = IngestSnapshotV2BaseSchema.superRefine(
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

export type IngestSnapshotV2 = z.infer<typeof IngestSnapshotV2Schema>;

export function parseIngestSnapshotV2(input: unknown): IngestSnapshotV2 {
  return IngestSnapshotV2Schema.parse(input);
}

export function safeParseIngestSnapshotV2(
  input: unknown
): z.ZodSafeParseResult<IngestSnapshotV2> {
  return IngestSnapshotV2Schema.safeParse(input);
}

export function serializeIngestSnapshotV2(input: unknown): string {
  return JSON.stringify(parseIngestSnapshotV2(input));
}

export function deserializeIngestSnapshotV2(
  serialized: string
): IngestSnapshotV2 {
  const parsed: unknown = JSON.parse(serialized);
  return parseIngestSnapshotV2(parsed);
}
