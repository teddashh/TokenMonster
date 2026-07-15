import { z } from "zod";

export const CONTRIBUTION_API_CONTRACT_VERSION = 1 as const;
export const CONTRIBUTION_CONSENT_PURPOSE = "contribution" as const;
export const DELETION_STATES_V1 = [
  "queued",
  "running",
  "complete",
  "failed"
] as const;

const UTC_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{3}))?Z$/;
const CONSENT_REVISION_PATTERN =
  /^contribution-(20\d{2})-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;
const UPLOAD_TOKEN_PATTERN =
  /^tm_u1_[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{43}$/;
const DELETION_TOKEN_PATTERN =
  /^tm_d1_[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{43}$/;
const DELETION_STATUS_TOKEN_PATTERN =
  /^tm_s1_[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{43}$/;
const OPAQUE_RECEIPT_ID_PATTERN = /^cr_[A-Za-z0-9_-]{22}$/;
const OPAQUE_DELETION_JOB_ID_PATTERN = /^del_[A-Za-z0-9_-]{22}$/;

function isCanonicalReasonableUtcInstant(value: string): boolean {
  const match = UTC_INSTANT_PATTERN.exec(value);
  if (match === null) {
    return false;
  }

  const milliseconds = match[7] ?? "000";
  const canonical =
    value.slice(0, value.length - 1).replace(/\.\d{3}$/u, "") +
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

function isValidConsentRevision(value: string): boolean {
  const match = CONSENT_REVISION_PATTERN.exec(value);
  if (match === null) {
    return false;
  }
  const date = value.slice("contribution-".length);
  const timestamp = Date.parse(date + "T00:00:00.000Z");
  return (
    Number.isFinite(timestamp) &&
    timestamp >= Date.parse("2020-01-01T00:00:00.000Z") &&
    timestamp < Date.parse("2100-01-01T00:00:00.000Z") &&
    new Date(timestamp).toISOString().slice(0, 10) === date
  );
}

export const ContributionUtcInstantV1Schema = z
  .string()
  .refine(
    isCanonicalReasonableUtcInstant,
    "Expected a canonical UTC timestamp from 2020 through 2099."
  );

export const ContributionConsentRevisionV1Schema = z
  .string()
  .refine(
    isValidConsentRevision,
    "Expected an immutable contribution consent revision."
  );

export const ContributionConsentAcknowledgementV1Schema = z.strictObject({
  purpose: z.literal(CONTRIBUTION_CONSENT_PURPOSE),
  documentRevision: ContributionConsentRevisionV1Schema,
  granted: z.literal(true),
  acknowledgedAt: ContributionUtcInstantV1Schema
});

export type ContributionConsentAcknowledgementV1 = z.infer<
  typeof ContributionConsentAcknowledgementV1Schema
>;

export const ContributionConsentChangeV1Schema = z.strictObject({
  purpose: z.literal(CONTRIBUTION_CONSENT_PURPOSE),
  documentRevision: ContributionConsentRevisionV1Schema,
  granted: z.boolean(),
  acknowledgedAt: ContributionUtcInstantV1Schema
});

export type ContributionConsentChangeV1 = z.infer<
  typeof ContributionConsentChangeV1Schema
>;

export const EnrollmentRequestV1Schema = z.strictObject({
  contractVersion: z.literal(CONTRIBUTION_API_CONTRACT_VERSION),
  consent: ContributionConsentAcknowledgementV1Schema
});

export type EnrollmentRequestV1 = z.infer<typeof EnrollmentRequestV1Schema>;

export const ContributionCredentialPairV1Schema = z
  .strictObject({
    uploadToken: z.string().regex(UPLOAD_TOKEN_PATTERN),
    deletionToken: z.string().regex(DELETION_TOKEN_PATTERN)
  })
  .refine(
    ({ uploadToken, deletionToken }) => uploadToken !== deletionToken,
    "Upload and deletion credentials must be separate."
  );

export type ContributionCredentialPairV1 = z.infer<
  typeof ContributionCredentialPairV1Schema
>;

export const ContributionConsentReceiptV1Schema = z.strictObject({
  receiptId: z.string().regex(OPAQUE_RECEIPT_ID_PATTERN),
  purpose: z.literal(CONTRIBUTION_CONSENT_PURPOSE),
  documentRevision: ContributionConsentRevisionV1Schema,
  granted: z.boolean(),
  acknowledgedAt: ContributionUtcInstantV1Schema,
  recordedAt: ContributionUtcInstantV1Schema
});

export type ContributionConsentReceiptV1 = z.infer<
  typeof ContributionConsentReceiptV1Schema
>;

export const EnrollmentResponseV1Schema = z.strictObject({
  contractVersion: z.literal(CONTRIBUTION_API_CONTRACT_VERSION),
  credentials: ContributionCredentialPairV1Schema,
  consentReceipt: ContributionConsentReceiptV1Schema,
  acceptedSnapshotSchemaVersions: z.tuple([z.literal("1")])
});

export type EnrollmentResponseV1 = z.infer<typeof EnrollmentResponseV1Schema>;

export const ConsentUpdateRequestV1Schema = z.strictObject({
  contractVersion: z.literal(CONTRIBUTION_API_CONTRACT_VERSION),
  consent: ContributionConsentChangeV1Schema
});

export type ConsentUpdateRequestV1 = z.infer<
  typeof ConsentUpdateRequestV1Schema
>;

export const ConsentUpdateResponseV1Schema = z.strictObject({
  contractVersion: z.literal(CONTRIBUTION_API_CONTRACT_VERSION),
  consentReceipt: ContributionConsentReceiptV1Schema,
  contributionStatus: z.enum(["active", "paused"])
});

export type ConsentUpdateResponseV1 = z.infer<
  typeof ConsentUpdateResponseV1Schema
>;

export const CredentialRotationResponseV1Schema = z.strictObject({
  contractVersion: z.literal(CONTRIBUTION_API_CONTRACT_VERSION),
  credentials: ContributionCredentialPairV1Schema,
  rotatedAt: ContributionUtcInstantV1Schema
});

export type CredentialRotationResponseV1 = z.infer<
  typeof CredentialRotationResponseV1Schema
>;

export const IngestReceiptV1Schema = z
  .strictObject({
    contractVersion: z.literal(CONTRIBUTION_API_CONTRACT_VERSION),
    batchId: z.uuid(),
    receivedAt: ContributionUtcInstantV1Schema,
    replayed: z.boolean(),
    status: z.enum(["accepted", "quarantined"]),
    summary: z.strictObject({
      appliedBuckets: z.number().int().min(0).max(30),
      staleBuckets: z.number().int().min(0).max(30),
      idempotentBuckets: z.number().int().min(0).max(30),
      quarantinedBuckets: z.number().int().min(0).max(30)
    })
  })
  .superRefine(({ status, summary }, context) => {
    const total =
      summary.appliedBuckets +
      summary.staleBuckets +
      summary.idempotentBuckets +
      summary.quarantinedBuckets;
    if (total < 1 || total > 30) {
      context.addIssue({
        code: "custom",
        path: ["summary"],
        message: "An ingest receipt must account for between 1 and 30 buckets."
      });
    }
    const isQuarantined = summary.quarantinedBuckets > 0;
    if ((status === "quarantined") !== isQuarantined) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Receipt status must reflect whether buckets were quarantined."
      });
    }
  });

export type IngestReceiptV1 = z.infer<typeof IngestReceiptV1Schema>;

export const PauseResponseV1Schema = z.strictObject({
  contractVersion: z.literal(CONTRIBUTION_API_CONTRACT_VERSION),
  status: z.literal("paused"),
  pausedAt: ContributionUtcInstantV1Schema,
  futureUploadsBlocked: z.literal(true),
  identifiableCurrentDataRetained: z.literal(true),
  anonymousHistoricalTotalsRetained: z.literal(true)
});

export type PauseResponseV1 = z.infer<typeof PauseResponseV1Schema>;

export const ResumeRequestV1Schema = z.strictObject({
  contractVersion: z.literal(CONTRIBUTION_API_CONTRACT_VERSION),
  consent: ContributionConsentAcknowledgementV1Schema
});

export type ResumeRequestV1 = z.infer<typeof ResumeRequestV1Schema>;

export const ResumeResponseV1Schema = z.strictObject({
  contractVersion: z.literal(CONTRIBUTION_API_CONTRACT_VERSION),
  status: z.literal("active"),
  resumedAt: ContributionUtcInstantV1Schema,
  consentReceipt: ContributionConsentReceiptV1Schema
});

export type ResumeResponseV1 = z.infer<typeof ResumeResponseV1Schema>;

export const DeletionAcceptedResponseV1Schema = z.strictObject({
  contractVersion: z.literal(CONTRIBUTION_API_CONTRACT_VERSION),
  jobId: z.string().regex(OPAQUE_DELETION_JOB_ID_PATTERN),
  statusToken: z.string().regex(DELETION_STATUS_TOKEN_PATTERN),
  status: z.literal("queued"),
  requestedAt: ContributionUtcInstantV1Schema,
  anonymousHistoricalTotalsRetained: z.literal(true)
});

export type DeletionAcceptedResponseV1 = z.infer<
  typeof DeletionAcceptedResponseV1Schema
>;

export const DeletionStatusResponseV1Schema = z
  .strictObject({
    contractVersion: z.literal(CONTRIBUTION_API_CONTRACT_VERSION),
    jobId: z.string().regex(OPAQUE_DELETION_JOB_ID_PATTERN),
    status: z.enum(DELETION_STATES_V1),
    requestedAt: ContributionUtcInstantV1Schema,
    finishedAt: ContributionUtcInstantV1Schema.nullable(),
    anonymousHistoricalTotalsRetained: z.literal(true)
  })
  .superRefine(({ finishedAt, status }, context) => {
    const terminal = status === "complete" || status === "failed";
    if (terminal !== (finishedAt !== null)) {
      context.addIssue({
        code: "custom",
        path: ["finishedAt"],
        message: "Terminal deletion states require finishedAt."
      });
    }
  });

export type DeletionStatusResponseV1 = z.infer<
  typeof DeletionStatusResponseV1Schema
>;

export function parseEnrollmentRequestV1(input: unknown): EnrollmentRequestV1 {
  return EnrollmentRequestV1Schema.parse(input);
}

export function parseConsentUpdateRequestV1(
  input: unknown
): ConsentUpdateRequestV1 {
  return ConsentUpdateRequestV1Schema.parse(input);
}

export function parseResumeRequestV1(input: unknown): ResumeRequestV1 {
  return ResumeRequestV1Schema.parse(input);
}

export function serializeContributionApiV1<T>(
  schema: z.ZodType<T>,
  input: unknown
): string {
  return JSON.stringify(schema.parse(input));
}
