import { IngestSnapshotV1Schema, type IngestSnapshotV1 } from "@tokenmonster/contracts";
import { z } from "zod";

import { UsageDomainError } from "./errors.js";
import type { AuthenticatedEnrollment } from "./types.js";

const SERVER_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{3}))?Z$/;

export const AuthenticatedEnrollmentSchema = z.strictObject({
  enrollmentId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/, "Expected an opaque server enrollment ID.")
});

function isCanonicalServerTimestamp(value: string): boolean {
  const match = SERVER_TIMESTAMP_PATTERN.exec(value);
  if (match === null) return false;
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

const ReceivedAtSchema = z
  .string()
  .refine(isCanonicalServerTimestamp, "Expected a canonical server UTC timestamp.");

export function parseAuthenticatedEnrollment(
  input: unknown
): AuthenticatedEnrollment {
  const parsed = AuthenticatedEnrollmentSchema.safeParse(input);
  if (!parsed.success) {
    throw new UsageDomainError(
      "AUTH_CONTEXT_INVALID",
      "Authenticated enrollment context is invalid."
    );
  }
  return parsed.data;
}

export function parseStrictIngestSnapshot(input: unknown): IngestSnapshotV1 {
  const parsed = IngestSnapshotV1Schema.safeParse(input);
  if (!parsed.success) {
    throw new UsageDomainError(
      "SCHEMA_INVALID",
      "IngestSnapshotV1 failed strict validation."
    );
  }
  return parsed.data;
}

export function parseReceivedAt(input: unknown): string {
  const parsed = ReceivedAtSchema.safeParse(input);
  if (!parsed.success) {
    throw new UsageDomainError(
      "RECEIVED_AT_INVALID",
      "Server receivedAt is invalid."
    );
  }
  return parsed.data;
}
