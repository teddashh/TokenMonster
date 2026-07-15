import {
  EnrollmentRequestV1Schema,
  IngestSnapshotV1Schema,
  type IngestSnapshotV1
} from "@tokenmonster/contracts";

import { ApiDomainError } from "./errors.js";
import type {
  Clock,
  CredentialScope,
  HmacSha256Digest,
  IssuedCredential,
  OpaqueIdGenerator,
  OpaqueIdKind,
  ParsedEnrollmentConsent,
  RateLimitDecision,
  RateLimitPort,
  RateLimitRoute,
  StoredCredential
} from "./types.js";

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const OPAQUE_ID_PATTERN_BY_KIND: Readonly<Record<OpaqueIdKind, RegExp>> = {
  installation: /^ins_[A-Za-z0-9_-]{22}$/,
  "consent-event": /^cr_[A-Za-z0-9_-]{22}$/,
  "deletion-job": /^del_[A-Za-z0-9_-]{22}$/
};
const SAFE_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;
const HMAC_BASE64URL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HMAC_HEX_PATTERN = /^[a-f0-9]{64}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;
const MAX_BEARER_LENGTH = 512;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const BEARER_PATTERN_BY_SCOPE: Readonly<Record<CredentialScope, RegExp>> = {
  upload: /^tm_u1_([A-Za-z0-9_-]{16,32})\.[A-Za-z0-9_-]{43}$/,
  deletion: /^tm_d1_([A-Za-z0-9_-]{16,32})\.[A-Za-z0-9_-]{43}$/,
  "deletion-status": /^tm_s1_([A-Za-z0-9_-]{16,32})\.[A-Za-z0-9_-]{43}$/
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseEnrollmentBody(input: unknown): ParsedEnrollmentConsent {
  if (isRecord(input) && isRecord(input["consent"])) {
    if (input["consent"]["granted"] === false) {
      throw new ApiDomainError("CONSENT_NOT_GRANTED");
    }
  }
  const parsed = EnrollmentRequestV1Schema.safeParse(input);
  if (!parsed.success) throw new ApiDomainError("SCHEMA_INVALID");
  return parsed.data;
}

export function parseIngestSnapshot(input: unknown): IngestSnapshotV1 {
  const parsed = IngestSnapshotV1Schema.safeParse(input);
  if (!parsed.success) throw new ApiDomainError("SCHEMA_INVALID");
  return parsed.data;
}

export function canonicalNow(clock: Clock): string {
  const date = clock.now();
  const milliseconds = date.getTime();
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds < Date.parse("2020-01-01T00:00:00.000Z") ||
    milliseconds >= Date.parse("2100-01-01T00:00:00.000Z")
  ) {
    throw new ApiDomainError("SERVICE_UNAVAILABLE");
  }
  return date.toISOString();
}

export function assertAcknowledgementTime(
  acknowledgedAt: string,
  now: string
): void {
  if (Date.parse(acknowledgedAt) > Date.parse(now) + MAX_CLOCK_SKEW_MS) {
    throw new ApiDomainError("ACKNOWLEDGEMENT_IN_FUTURE");
  }
}

export function assertCurrentConsent(
  suppliedRevision: string,
  currentRevision: string
): void {
  if (suppliedRevision !== currentRevision) {
    throw new ApiDomainError("CONSENT_REQUIRED");
  }
}

export function assertRateLimitKey(value: unknown): string {
  if (typeof value !== "string" || !SAFE_KEY_PATTERN.test(value)) {
    throw new ApiDomainError("SCHEMA_INVALID");
  }
  return value;
}

export function assertBearerToken(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 32 ||
    value.length > MAX_BEARER_LENGTH ||
    /\s/u.test(value)
  ) {
    throw new ApiDomainError("TOKEN_INVALID");
  }
  return value;
}

export function assertIngestIdempotencyKey(
  supplied: unknown,
  batchId: string
): string {
  if (typeof supplied !== "string") {
    throw new ApiDomainError("IDEMPOTENCY_KEY_INVALID");
  }
  if (supplied !== batchId) {
    throw new ApiDomainError("IDEMPOTENCY_KEY_MISMATCH");
  }
  return supplied;
}

export function assertDeletionIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !SAFE_KEY_PATTERN.test(value)) {
    throw new ApiDomainError("IDEMPOTENCY_KEY_INVALID");
  }
  return value;
}

export function assertDeletionJobId(value: unknown): string {
  if (typeof value !== "string" || !/^del_[A-Za-z0-9_-]{22}$/.test(value)) {
    throw new ApiDomainError("SCHEMA_INVALID");
  }
  return value;
}

export function assertRestoredInstallationId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !OPAQUE_ID_PATTERN_BY_KIND.installation.test(value)
  ) {
    throw new ApiDomainError("SERVICE_UNAVAILABLE");
  }
  return value;
}

export function assertOpaqueId(
  ids: OpaqueIdGenerator,
  kind: OpaqueIdKind
): string {
  const value = ids.generate(kind);
  if (!OPAQUE_ID_PATTERN_BY_KIND[kind].test(value)) {
    throw new ApiDomainError("SERVICE_UNAVAILABLE");
  }
  return value;
}

export function isHmacSha256Digest(value: string): boolean {
  return HMAC_BASE64URL_PATTERN.test(value) || HMAC_HEX_PATTERN.test(value);
}

export function assertHmacSha256Digest(
  value: unknown
): HmacSha256Digest {
  if (typeof value !== "string" || !isHmacSha256Digest(value)) {
    throw new ApiDomainError("CREDENTIAL_SERVICE_INVALID");
  }
  return value;
}

export function assertStoredCredential(
  input: StoredCredential,
  scope: CredentialScope
): StoredCredential {
  if (
    input.scope !== scope ||
    !OPAQUE_ID_PATTERN.test(input.publicTokenId) ||
    !isHmacSha256Digest(input.hmacDigest) ||
    !KEY_ID_PATTERN.test(input.hmacKeyId)
  ) {
    throw new ApiDomainError("CREDENTIAL_SERVICE_INVALID");
  }
  return Object.freeze({ ...input });
}

export function assertIssuedCredential(
  input: IssuedCredential,
  scope: CredentialScope
): IssuedCredential {
  const bearerMatch =
    typeof input.bearerToken === "string"
      ? BEARER_PATTERN_BY_SCOPE[scope].exec(input.bearerToken)
      : null;
  if (
    input.entropyBits !== 256 ||
    bearerMatch === null
  ) {
    throw new ApiDomainError("CREDENTIAL_SERVICE_INVALID");
  }
  const stored = assertStoredCredential(input.stored, scope);
  if (bearerMatch[1] !== stored.publicTokenId) {
    throw new ApiDomainError("CREDENTIAL_SERVICE_INVALID");
  }
  return Object.freeze({
    bearerToken: input.bearerToken,
    entropyBits: 256 as const,
    stored
  });
}

export function assertSeparatedCredentials(
  upload: IssuedCredential,
  deletion: IssuedCredential
): void {
  if (
    upload.bearerToken === deletion.bearerToken ||
    upload.stored.publicTokenId === deletion.stored.publicTokenId ||
    upload.stored.hmacDigest === deletion.stored.hmacDigest
  ) {
    throw new ApiDomainError("CREDENTIAL_SERVICE_INVALID");
  }
}

export async function enforceRateLimit(
  port: RateLimitPort,
  route: RateLimitRoute,
  subjectKey: string,
  at: string
): Promise<void> {
  const decision: RateLimitDecision = await port.consume({
    route,
    subjectKey,
    at
  });
  if (typeof decision.allowed !== "boolean") {
    throw new ApiDomainError("SERVICE_UNAVAILABLE");
  }
  if (!decision.allowed) {
    const retry = decision.retryAfterSeconds;
    throw new ApiDomainError(
      "RATE_LIMITED",
      typeof retry === "number" && Number.isFinite(retry) ? retry : 1
    );
  }
}

export function addUtcDays(timestamp: string, days: number): string {
  return new Date(Date.parse(timestamp) + days * 86_400_000).toISOString();
}

export function assertBucketFreshness(
  snapshot: IngestSnapshotV1,
  receivedAt: string
): void {
  const receivedAtMs = Date.parse(receivedAt);
  const currentDayMs = Date.parse(receivedAt.slice(0, 10) + "T00:00:00.000Z");
  const retentionMs = 30 * 86_400_000;
  for (const bucket of snapshot.buckets) {
    const bucketMs = Date.parse(bucket.bucketStart);
    if (bucketMs > currentDayMs || bucketMs + retentionMs <= receivedAtMs) {
      throw new ApiDomainError("BUCKET_OUTSIDE_RETENTION");
    }
  }
}
