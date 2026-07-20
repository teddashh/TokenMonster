import { ApiDomainError, sanitizeUnexpected } from "./errors.js";
import type {
  ConsentReceiptRecord,
  EnrollmentCommand,
  EnrollmentDependencies,
  EnrollmentResult,
  InstallationRecord,
  RecoverableEnrollmentCommand,
  RecoverableEnrollmentDependencies,
  RecoverableEnrollmentRecord,
  RecoverableEnrollmentResult,
  StoredCredential
} from "./types.js";
import {
  assertAcknowledgementTime,
  assertCurrentConsent,
  assertFreshRecoverableEnrollmentAcknowledgement,
  assertHmacSha256Digest,
  assertIssuedCredential,
  assertOpaqueId,
  assertRateLimitKey,
  assertSeparatedCredentials,
  assertStoredCredential,
  canonicalNow,
  enforceRateLimit,
  parseEnrollmentBody,
  parseRecoverableEnrollmentBody
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
      // Contribution API V1 keeps its published credential-bearing response
      // byte-shape compatible. `/v1/compatibility` advertises V2 ingest.
      acceptedSnapshotSchemaVersions: Object.freeze(["1"] as const)
    });
  });
}

function publicIdFromV2Bearer(
  bearerToken: string,
  prefix: "tm_u2_" | "tm_d2_" | "tm_r2_"
): string {
  if (!bearerToken.startsWith(prefix)) {
    throw new ApiDomainError("TOKEN_INVALID");
  }
  const separator = bearerToken.indexOf(".", prefix.length);
  if (separator < 0) throw new ApiDomainError("TOKEN_INVALID");
  return bearerToken.slice(prefix.length, separator);
}

function assertIndependentStoredCredentials(
  upload: StoredCredential,
  deletion: StoredCredential,
  recovery: StoredCredential
): void {
  const credentials = [upload, deletion, recovery];
  if (
    new Set(credentials.map(({ publicTokenId }) => publicTokenId)).size !== 3 ||
    new Set(credentials.map(({ hmacDigest }) => hmacDigest)).size !== 3
  ) {
    throw new ApiDomainError("CREDENTIAL_SERVICE_INVALID");
  }
}

function toRecoverableResult(
  record: RecoverableEnrollmentRecord
): RecoverableEnrollmentResult {
  return Object.freeze({
    contractVersion: 2 as const,
    status: "active" as const,
    consentReceipt: Object.freeze({
      receiptId: record.consentReceipt.eventId,
      purpose: "contribution" as const,
      documentRevision: record.consentReceipt.documentRevision,
      granted: true as const,
      acknowledgedAt: record.consentReceipt.acknowledgedAt,
      recordedAt: record.consentReceipt.recordedAt
    }),
    acceptedSnapshotSchemaVersions: Object.freeze(["1", "2"] as const)
  });
}

async function recoverExactEnrollment(
  request: ReturnType<typeof parseRecoverableEnrollmentBody>,
  recoveryPublicTokenId: string,
  record: RecoverableEnrollmentRecord,
  dependencies: RecoverableEnrollmentDependencies
): Promise<RecoverableEnrollmentResult> {
  const installation = record.installation;
  const receipt = record.consentReceipt;
  const upload = installation.uploadCredential;
  const deletion = installation.deletionCredential;
  const recovery = assertStoredCredential(
    record.recoveryCredential,
    "enrollment-recovery"
  );
  if (
    recovery.publicTokenId !== recoveryPublicTokenId ||
    installation.status !== "active" ||
    upload === null ||
    deletion === null ||
    receipt.installationId !== installation.installationId ||
    receipt.eventId.length === 0 ||
    receipt.purpose !== request.consent.purpose ||
    receipt.documentRevision !== request.consent.documentRevision ||
    receipt.granted !== request.consent.granted ||
    receipt.acknowledgedAt !== request.consent.acknowledgedAt
  ) {
    throw new ApiDomainError("TOKEN_INVALID");
  }
  const valid = await Promise.all([
    dependencies.credentials.verify(
      request.credentials.uploadToken,
      assertStoredCredential(upload, "upload")
    ),
    dependencies.credentials.verify(
      request.credentials.deletionToken,
      assertStoredCredential(deletion, "deletion")
    ),
    dependencies.credentials.verify(
      request.credentials.recoveryToken,
      recovery
    )
  ]);
  if (valid.some((value) => value !== true)) {
    throw new ApiDomainError("TOKEN_INVALID");
  }
  return toRecoverableResult(record);
}

/**
 * V2 enrollment accepts credentials already durably held by the trusted
 * client. Repeating the exact request recovers the original receipt; replay
 * deliberately does not reapply acknowledgement freshness or current-policy
 * checks because doing so would recreate the response-loss orphan window.
 */
export async function enrollContributorRecoverably(
  command: RecoverableEnrollmentCommand,
  dependencies: RecoverableEnrollmentDependencies
): Promise<RecoverableEnrollmentResult> {
  return sanitizeUnexpected(async () => {
    const request = parseRecoverableEnrollmentBody(command.body);
    const rateLimitKey = assertRateLimitKey(command.rateLimitKey);
    const recordedAt = canonicalNow(dependencies.clock);
    await enforceRateLimit(
      dependencies.rateLimit,
      "enrollment",
      rateLimitKey,
      recordedAt
    );

    const recoveryPublicTokenId = publicIdFromV2Bearer(
      request.credentials.recoveryToken,
      "tm_r2_"
    );
    const presented = await dependencies.credentials.inspect(
      request.credentials.recoveryToken
    );
    if (presented?.publicTokenId !== recoveryPublicTokenId) {
      throw new ApiDomainError("TOKEN_INVALID");
    }

    const existing = await dependencies.storage.findRecoverableEnrollment(
      recoveryPublicTokenId
    );
    if (existing !== null) {
      return recoverExactEnrollment(
        request,
        recoveryPublicTokenId,
        existing,
        dependencies
      );
    }

    assertCurrentConsent(
      request.consent.documentRevision,
      dependencies.policy.currentConsentDocumentRevision
    );
    assertFreshRecoverableEnrollmentAcknowledgement(
      request.consent.acknowledgedAt,
      recordedAt
    );

    const [rawUpload, rawDeletion, rawRecovery] = await Promise.all([
      dependencies.credentials.acceptPresentedV2(
        "upload",
        request.credentials.uploadToken
      ),
      dependencies.credentials.acceptPresentedV2(
        "deletion",
        request.credentials.deletionToken
      ),
      dependencies.credentials.acceptPresentedV2(
        "enrollment-recovery",
        request.credentials.recoveryToken
      )
    ]);
    const upload = assertStoredCredential(rawUpload, "upload");
    const deletion = assertStoredCredential(rawDeletion, "deletion");
    const recovery = assertStoredCredential(
      rawRecovery,
      "enrollment-recovery"
    );
    if (
      upload.publicTokenId !== publicIdFromV2Bearer(
        request.credentials.uploadToken,
        "tm_u2_"
      ) ||
      deletion.publicTokenId !== publicIdFromV2Bearer(
        request.credentials.deletionToken,
        "tm_d2_"
      ) ||
      recovery.publicTokenId !== recoveryPublicTokenId
    ) {
      throw new ApiDomainError("CREDENTIAL_SERVICE_INVALID");
    }
    assertIndependentStoredCredentials(upload, deletion, recovery);

    const installationId = assertOpaqueId(dependencies.ids, "installation");
    const receiptId = assertOpaqueId(dependencies.ids, "consent-event");
    assertHmacSha256Digest(
      await dependencies.credentials.deriveSuppressionMarker(installationId)
    );
    const installation: InstallationRecord = Object.freeze({
      installationId,
      status: "active",
      consentDocumentRevision: request.consent.documentRevision,
      uploadCredential: upload,
      deletionCredential: deletion,
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
    const created: RecoverableEnrollmentRecord = Object.freeze({
      installation,
      consentReceipt,
      recoveryCredential: recovery
    });

    try {
      await dependencies.storage.createRecoverableEnrollmentAtomically({
        installation,
        consentReceipt,
        recoveryCredential: recovery
      });
      return toRecoverableResult(created);
    } catch (creationError: unknown) {
      // Covers a concurrent identical creator and a storage acknowledgement
      // lost after commit. A different request can never pass all 3 verifier
      // checks plus exact accepted-consent equality.
      const recovered = await dependencies.storage.findRecoverableEnrollment(
        recoveryPublicTokenId
      );
      if (recovered !== null) {
        return recoverExactEnrollment(
          request,
          recoveryPublicTokenId,
          recovered,
          dependencies
        );
      }
      throw creationError;
    }
  });
}
