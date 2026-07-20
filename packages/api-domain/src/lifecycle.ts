import {
  PauseResponseV1Schema,
  ResumeResponseV1Schema
} from "@tokenmonster/contracts";

import {
  assertCandidateValid,
  authenticateCredential
} from "./auth.js";
import { ApiDomainError, sanitizeUnexpected } from "./errors.js";
import type {
  ConsentReceiptRecord,
  InstallationRecord,
  LifecycleTransactionPort,
  PauseCommand,
  PauseDependencies,
  PauseResult,
  ResumeCommand,
  ResumeDependencies,
  ResumeResult
} from "./types.js";
import {
  assertAcknowledgementTime,
  assertCurrentConsent,
  assertOpaqueId,
  assertRateLimitKey,
  canonicalNow,
  enforceRateLimit,
  parseResumeBody
} from "./validation.js";

type LifecycleAuthentication = Readonly<{
  bearerToken: string;
  installationId: string;
  publicTokenId: string;
}>;

function assertInstallationMatches(
  installation: InstallationRecord | null,
  installationId: string
): asserts installation is InstallationRecord {
  if (
    installation === null ||
    installation.installationId !== installationId
  ) {
    throw new ApiDomainError("TOKEN_INVALID");
  }
}

function assertMutableStatus(installation: InstallationRecord): void {
  if (installation.status === "deleting") {
    throw new ApiDomainError("INSTALLATION_DELETING");
  }
  if (installation.status === "deleted") {
    throw new ApiDomainError("INSTALLATION_DELETED");
  }
}

async function authenticateInsideTransaction(
  transaction: LifecycleTransactionPort,
  authentication: LifecycleAuthentication,
  dependencies: PauseDependencies
): Promise<InstallationRecord> {
  const candidate = await transaction.findCredentialCandidate(
    "upload",
    authentication.publicTokenId
  );
  await assertCandidateValid(
    authentication.bearerToken,
    "upload",
    authentication.publicTokenId,
    candidate,
    dependencies.credentials
  );
  const installation = await transaction.getInstallation();
  assertInstallationMatches(installation, authentication.installationId);
  assertMutableStatus(installation);
  return installation;
}

function pauseResult(pausedAt: string): PauseResult {
  const parsed = PauseResponseV1Schema.safeParse({
    contractVersion: 1 as const,
    status: "paused" as const,
    pausedAt,
    futureUploadsBlocked: true as const,
    identifiableCurrentDataRetained: true as const,
    anonymousHistoricalTotalsRetained: true as const
  });
  if (!parsed.success) throw new ApiDomainError("SERVICE_UNAVAILABLE");
  return Object.freeze(parsed.data);
}

function resumeResult(receipt: ConsentReceiptRecord): ResumeResult {
  const parsed = ResumeResponseV1Schema.safeParse({
    contractVersion: 1 as const,
    status: "active" as const,
    resumedAt: receipt.recordedAt,
    consentReceipt: Object.freeze({
      receiptId: receipt.eventId,
      purpose: "contribution" as const,
      documentRevision: receipt.documentRevision,
      granted: true as const,
      acknowledgedAt: receipt.acknowledgedAt,
      recordedAt: receipt.recordedAt
    })
  });
  if (!parsed.success || parsed.data.consentReceipt.granted !== true) {
    throw new ApiDomainError("SERVICE_UNAVAILABLE");
  }
  return Object.freeze({
    ...parsed.data,
    consentReceipt: Object.freeze({
      ...parsed.data.consentReceipt,
      granted: true as const
    })
  });
}

async function authenticate(
  bearerToken: string,
  dependencies: PauseDependencies
): Promise<LifecycleAuthentication> {
  const authenticated = await authenticateCredential(
    bearerToken,
    "upload",
    dependencies.credentials,
    dependencies.storage
  );
  return Object.freeze({
    bearerToken: authenticated.bearerToken,
    installationId: authenticated.candidate.installationId,
    publicTokenId: authenticated.candidate.credential.publicTokenId
  });
}

export async function pauseContribution(
  command: PauseCommand,
  dependencies: PauseDependencies
): Promise<PauseResult> {
  return sanitizeUnexpected(async () => {
    const at = canonicalNow(dependencies.clock);
    const rateLimitKey = assertRateLimitKey(command.rateLimitKey);
    await enforceRateLimit(
      dependencies.rateLimit,
      "lifecycle",
      rateLimitKey,
      at
    );
    const authentication = await authenticate(
      command.bearerToken,
      dependencies
    );
    return dependencies.storage.withLifecycleTransaction(
      authentication.installationId,
      async (transaction) => {
        const installation = await authenticateInsideTransaction(
          transaction,
          authentication,
          dependencies
        );
        if (installation.status === "paused") {
          if (installation.pausedAt === null) {
            throw new ApiDomainError("SERVICE_UNAVAILABLE");
          }
          return pauseResult(installation.pausedAt);
        }
        await transaction.pause(at);
        return pauseResult(at);
      }
    );
  });
}

export async function resumeContribution(
  command: ResumeCommand,
  dependencies: ResumeDependencies
): Promise<ResumeResult> {
  return sanitizeUnexpected(async () => {
    const at = canonicalNow(dependencies.clock);
    const rateLimitKey = assertRateLimitKey(command.rateLimitKey);
    await enforceRateLimit(
      dependencies.rateLimit,
      "lifecycle",
      rateLimitKey,
      at
    );
    const authentication = await authenticate(
      command.bearerToken,
      dependencies
    );
    const request = parseResumeBody(command.body);
    assertCurrentConsent(
      request.consent.documentRevision,
      dependencies.policy.currentConsentDocumentRevision
    );
    assertAcknowledgementTime(request.consent.acknowledgedAt, at);

    return dependencies.storage.withLifecycleTransaction(
      authentication.installationId,
      async (transaction) => {
        const installation = await authenticateInsideTransaction(
          transaction,
          authentication,
          dependencies
        );
        if (
          installation.status === "active" &&
          installation.consentDocumentRevision ===
            request.consent.documentRevision
        ) {
          const existing = await transaction.getLatestGrantedConsentReceipt(
            request.consent.documentRevision
          );
          if (
            existing === null ||
            existing.installationId !== installation.installationId
          ) {
            throw new ApiDomainError("SERVICE_UNAVAILABLE");
          }
          return resumeResult(existing);
        }

        const receipt: ConsentReceiptRecord = Object.freeze({
          eventId: assertOpaqueId(dependencies.ids, "consent-event"),
          installationId: installation.installationId,
          purpose: "contribution" as const,
          documentRevision: request.consent.documentRevision,
          granted: true as const,
          acknowledgedAt: request.consent.acknowledgedAt,
          recordedAt: at
        });
        await transaction.resume({ consentReceipt: receipt, at });
        return resumeResult(receipt);
      }
    );
  });
}
