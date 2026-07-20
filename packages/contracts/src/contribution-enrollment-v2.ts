import { z } from "zod";

import {
  ContributionConsentAcknowledgementV1Schema,
  ContributionConsentReceiptV1Schema
} from "./contribution-api-v1.js";

export const CONTRIBUTION_ENROLLMENT_CONTRACT_VERSION_V2 = 2 as const;

const CLIENT_UPLOAD_TOKEN_V2_PATTERN =
  /^tm_u2_[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const CLIENT_DELETION_TOKEN_V2_PATTERN =
  /^tm_d2_[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const CLIENT_RECOVERY_TOKEN_V2_PATTERN =
  /^tm_r2_[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

function tokenParts(
  token: string,
  prefix: "tm_u2_" | "tm_d2_" | "tm_r2_"
): Readonly<{ publicTokenId: string; secret: string }> {
  const separator = token.indexOf(".", prefix.length);
  return Object.freeze({
    publicTokenId: token.slice(prefix.length, separator),
    secret: token.slice(separator + 1)
  });
}

export const RecoverableEnrollmentCredentialsV2Schema = z
  .strictObject({
    uploadToken: z.string().regex(CLIENT_UPLOAD_TOKEN_V2_PATTERN),
    deletionToken: z.string().regex(CLIENT_DELETION_TOKEN_V2_PATTERN),
    recoveryToken: z.string().regex(CLIENT_RECOVERY_TOKEN_V2_PATTERN)
  })
  .superRefine((credentials, context) => {
    const parts = [
      tokenParts(credentials.uploadToken, "tm_u2_"),
      tokenParts(credentials.deletionToken, "tm_d2_"),
      tokenParts(credentials.recoveryToken, "tm_r2_")
    ];
    const publicIds = parts.map(({ publicTokenId }) => publicTokenId);
    if (new Set(publicIds).size !== publicIds.length) {
      context.addIssue({
        code: "custom",
        path: ["recoveryToken"],
        message: "Enrollment credentials must use independent public IDs."
      });
    }
    if (new Set(parts.map(({ secret }) => secret)).size !== parts.length) {
      context.addIssue({
        code: "custom",
        path: ["recoveryToken"],
        message: "Enrollment credentials must use independent secrets."
      });
    }
  });

export type RecoverableEnrollmentCredentialsV2 = z.infer<
  typeof RecoverableEnrollmentCredentialsV2Schema
>;

export const EnrollmentRequestV2Schema = z.strictObject({
  contractVersion: z.literal(CONTRIBUTION_ENROLLMENT_CONTRACT_VERSION_V2),
  credentials: RecoverableEnrollmentCredentialsV2Schema,
  consent: ContributionConsentAcknowledgementV1Schema
});

export type EnrollmentRequestV2 = z.infer<typeof EnrollmentRequestV2Schema>;

export const EnrollmentResponseV2Schema = z.strictObject({
  contractVersion: z.literal(CONTRIBUTION_ENROLLMENT_CONTRACT_VERSION_V2),
  status: z.literal("active"),
  consentReceipt: ContributionConsentReceiptV1Schema,
  acceptedSnapshotSchemaVersions: z.tuple([z.literal("1"), z.literal("2")])
});

export type EnrollmentResponseV2 = z.infer<typeof EnrollmentResponseV2Schema>;

export function parseEnrollmentRequestV2(input: unknown): EnrollmentRequestV2 {
  return EnrollmentRequestV2Schema.parse(input);
}

export function serializeContributionEnrollmentV2<T>(
  schema: z.ZodType<T>,
  input: unknown
): string {
  return JSON.stringify(schema.parse(input));
}
