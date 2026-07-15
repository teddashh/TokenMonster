import { ApiDomainError, sanitizeUnexpected } from "./errors.js";
import type {
  ConsentReceiptRecord,
  EnrollmentCommand,
  EnrollmentDependencies,
  EnrollmentResult,
  InstallationRecord
} from "./types.js";
import {
  assertAcknowledgementTime,
  assertCurrentConsent,
  assertHmacSha256Digest,
  assertIssuedCredential,
  assertOpaqueId,
  assertRateLimitKey,
  assertSeparatedCredentials,
  canonicalNow,
  enforceRateLimit,
  parseEnrollmentBody
} from "./validation.js";

export async function enrollContributor(
  command: EnrollmentCommand,
  dependencies: EnrollmentDependencies
): Promise<EnrollmentResult> {
  return sanitizeUnexpected(async () => {
    const request = parseEnrollmentBody(command.body);
    const rateLimitKey = assertRateLimitKey(command.rateLimitKey);
    const recordedAt = canonicalNow(dependencies.clock);
    await enforceRateLimit(
      dependencies.rateLimit,
      "enrollment",
      rateLimitKey,
      recordedAt
    );

    assertCurrentConsent(
      request.consent.documentRevision,
      dependencies.policy.currentConsentDocumentRevision
    );
    assertAcknowledgementTime(request.consent.acknowledgedAt, recordedAt);

    const installationId = assertOpaqueId(dependencies.ids, "installation");
    const receiptId = assertOpaqueId(dependencies.ids, "consent-event");
    const upload = assertIssuedCredential(
      await dependencies.credentials.issue("upload"),
      "upload"
    );
    const deletion = assertIssuedCredential(
      await dependencies.credentials.issue("deletion"),
      "deletion"
    );
    assertSeparatedCredentials(upload, deletion);
    assertHmacSha256Digest(
      await dependencies.credentials.deriveSuppressionMarker(installationId)
    );

    const installation: InstallationRecord = Object.freeze({
      installationId,
      status: "active",
      consentDocumentRevision: request.consent.documentRevision,
      uploadCredential: upload.stored,
      deletionCredential: deletion.stored,
      createdAt: recordedAt,
      pausedAt: null,
      deletingAt: null,
      deletedAt: null
    });
    const consentReceipt: ConsentReceiptRecord = Object.freeze({
      eventId: receiptId,
      installationId,
      purpose: "contribution",
      documentRevision: request.consent.documentRevision,
      granted: true,
      acknowledgedAt: request.consent.acknowledgedAt,
      recordedAt
    });

    await dependencies.storage.createEnrollmentAtomically({
      installation,
      consentReceipt
    });

    if (
      upload.bearerToken === deletion.bearerToken ||
      installation.uploadCredential === null ||
      installation.deletionCredential === null
    ) {
      throw new ApiDomainError("CREDENTIAL_SERVICE_INVALID");
    }

    return Object.freeze({
      contractVersion: 1 as const,
      credentials: Object.freeze({
        uploadToken: upload.bearerToken,
        deletionToken: deletion.bearerToken
      }),
      consentReceipt: Object.freeze({
        receiptId,
        purpose: "contribution" as const,
        documentRevision: consentReceipt.documentRevision,
        granted: true as const,
        acknowledgedAt: consentReceipt.acknowledgedAt,
        recordedAt: consentReceipt.recordedAt
      }),
      acceptedSnapshotSchemaVersions: Object.freeze(["1"] as const)
    });
  });
}
