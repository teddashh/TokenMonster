import {
  DailyAggregateBucketV1Schema,
  SupportedCollectorIdentitySchema,
  type DailyAggregateBucketV1,
  type SupportedCollectorIdentity
} from "@tokenmonster/contracts";

import {
  canonicalizeJson,
  hashCanonicalText,
  type CanonicalHasher
} from "./canonical-json.js";
import { UsageDomainError } from "./errors.js";
import { parseAuthenticatedEnrollment, parseStrictIngestSnapshot } from "./validation.js";
import type { AuthenticatedEnrollment } from "./types.js";

function parseCanonicalRowParts(
  enrollmentInput: unknown,
  collectorInput: unknown,
  bucketInput: unknown
): {
  enrollment: AuthenticatedEnrollment;
  collector: SupportedCollectorIdentity;
  bucket: DailyAggregateBucketV1;
} {
  const enrollment = parseAuthenticatedEnrollment(enrollmentInput);
  const collector = SupportedCollectorIdentitySchema.safeParse(collectorInput);
  const bucket = DailyAggregateBucketV1Schema.safeParse(bucketInput);
  if (!collector.success || !bucket.success) {
    throw new UsageDomainError(
      "STATE_INVALID",
      "Cannot serialize an invalid canonical server row."
    );
  }
  return { enrollment, collector: collector.data, bucket: bucket.data };
}

export function canonicalSerializeIngestBatch(input: unknown): string {
  return canonicalizeJson(parseStrictIngestSnapshot(input));
}

export function canonicalSerializeServerRow(
  enrollmentInput: unknown,
  collectorInput: unknown,
  bucketInput: unknown
): string {
  const { enrollment, collector, bucket } = parseCanonicalRowParts(
    enrollmentInput,
    collectorInput,
    bucketInput
  );
  return canonicalizeJson({
    schemaVersion:
      collector.kind === "tokentracker-sidecar" ? "2" : "1",
    enrollmentId: enrollment.enrollmentId,
    bucketStart: bucket.bucketStart,
    provider: bucket.provider,
    modelFamily: bucket.modelFamily,
    tool: bucket.tool,
    valueQuality: bucket.valueQuality,
    revision: bucket.revision,
    tokens: bucket.tokens,
    collector
  });
}

export async function hashIngestBatch(
  input: unknown,
  hasher?: CanonicalHasher
): Promise<string> {
  return hasher === undefined
    ? hashCanonicalText(canonicalSerializeIngestBatch(input))
    : hashCanonicalText(canonicalSerializeIngestBatch(input), hasher);
}

export async function hashServerRow(
  enrollmentInput: unknown,
  collectorInput: unknown,
  bucketInput: unknown,
  hasher?: CanonicalHasher
): Promise<string> {
  const canonical = canonicalSerializeServerRow(
    enrollmentInput,
    collectorInput,
    bucketInput
  );
  return hasher === undefined
    ? hashCanonicalText(canonical)
    : hashCanonicalText(canonical, hasher);
}
