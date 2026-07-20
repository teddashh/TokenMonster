import { z } from "zod";

import {
  CollectorIdentityV1Schema,
  IngestSnapshotV1Schema,
  type CollectorIdentityV1,
  type CollectorKindV1,
  type IngestSnapshotV1
} from "./ingest-v1.js";
import {
  CollectorIdentityV2Schema,
  IngestSnapshotV2Schema,
  type CollectorIdentityV2,
  type CollectorKindV2,
  type IngestSnapshotV2
} from "./ingest-v2.js";

export const ACCEPTED_INGEST_SNAPSHOT_SCHEMA_VERSIONS = ["1", "2"] as const;

export const SupportedIngestSnapshotSchema = z.union([
  IngestSnapshotV1Schema,
  IngestSnapshotV2Schema
]);

export const SupportedCollectorIdentitySchema = z.union([
  CollectorIdentityV1Schema,
  CollectorIdentityV2Schema
]);

export type SupportedIngestSnapshot =
  | IngestSnapshotV1
  | IngestSnapshotV2;
export type SupportedCollectorIdentity =
  | CollectorIdentityV1
  | CollectorIdentityV2;
export type SupportedCollectorKind = CollectorKindV1 | CollectorKindV2;

export function parseSupportedIngestSnapshot(
  input: unknown
): SupportedIngestSnapshot {
  return SupportedIngestSnapshotSchema.parse(input);
}

export function safeParseSupportedIngestSnapshot(
  input: unknown
): z.ZodSafeParseResult<SupportedIngestSnapshot> {
  return SupportedIngestSnapshotSchema.safeParse(input);
}
