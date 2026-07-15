import {
  DeletionStatusResponseV1Schema
} from "@tokenmonster/contracts";
import {
  assertCandidateValid,
  authenticateCredential
} from "./auth.js";
import { ApiDomainError, sanitizeUnexpected } from "./errors.js";
import type {
  CompleteDeletionCommand,
  CompleteDeletionDependencies,
  CompleteDeletionResult,
  CredentialCandidate,
  DeleteCommand,
  DeleteResult,
  DeletionDependencies,
  DeletionRequestRecord,
  DeletionStatusCommand,
  DeletionStatusDependencies,
  DeletionStatusRecord,
  DeletionStatusResult,
  DeletionTransactionPort,
  InstallationRecord,
  SuppressionReplayDependencies,
  SuppressionReplayResult
} from "./types.js";
import {
  addUtcDays,
  assertDeletionIdempotencyKey,
  assertDeletionJobId,
  assertHmacSha256Digest,
  assertIssuedCredential,
  assertOpaqueId,
  assertRateLimitKey,
  assertRestoredInstallationId,
  canonicalNow,
  enforceRateLimit
} from "./validation.js";

type AuthenticatedDeletion = Readonly<{
  bearerToken: string;
  candidate: CredentialCandidate;
  idempotencyKey: string;
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

async function authenticateInsideDeletionTransaction(
  transaction: DeletionTransactionPort,
  authentication: AuthenticatedDeletion,
  dependencies: DeletionDependencies
): Promise<InstallationRecord> {
  const currentCandidate = await transaction.findCredentialCandidate(
    "deletion",
    authentication.candidate.credential.publicTokenId
  );
  await assertCandidateValid(
    authentication.bearerToken,
    "deletion",
    authentication.candidate.credential.publicTokenId,
    currentCandidate,
    dependencies.credentials
  );
  const installation = await transaction.getInstallation();
  assertInstallationMatches(
    installation,
    authentication.candidate.installationId
  );
  return installation;
}

async function inspectDeletionRequest(
  transaction: DeletionTransactionPort,
  authentication: AuthenticatedDeletion,
  dependencies: DeletionDependencies
): Promise<
  Readonly<{
    installation: InstallationRecord;
    existing: DeletionRequestRecord | null;
  }>
> {
  const installation = await authenticateInsideDeletionTransaction(
    transaction,
    authentication,
    dependencies
  );
  const existing = await transaction.getDeletionRequest(
    authentication.idempotencyKey
  );
  if (existing !== null) {
    if (existing.installationId !== installation.installationId) {
      throw new ApiDomainError("TOKEN_INVALID");
    }
    return Object.freeze({ installation, existing });
  }
  if (installation.status === "deleting") {
    throw new ApiDomainError("INSTALLATION_DELETING");
  }
  if (installation.status === "deleted") {
    throw new ApiDomainError("INSTALLATION_DELETED");
  }
  return Object.freeze({ installation, existing: null });
}

async function beginDeletionRequest(
  transaction: DeletionTransactionPort,
  authentication: AuthenticatedDeletion,
  requestedAt: string,
  dependencies: DeletionDependencies
): Promise<
  Readonly<{
    request: DeletionRequestRecord;
    statusToken: string;
  }>
> {
  const inspected = await inspectDeletionRequest(
    transaction,
    authentication,
    dependencies
  );
  if (inspected.existing !== null) {
    const statusCredential = assertIssuedCredential(
      await dependencies.credentials.issueDeletionStatus(
        inspected.existing.jobId
      ),
      "deletion-status"
    );
    const expected = inspected.existing.statusCredential;
    if (
      statusCredential.stored.scope !== expected.scope ||
      statusCredential.stored.publicTokenId !== expected.publicTokenId ||
      statusCredential.stored.hmacDigest !== expected.hmacDigest ||
      statusCredential.stored.hmacKeyId !== expected.hmacKeyId ||
      !(await dependencies.credentials.verify(
        statusCredential.bearerToken,
        expected
      ))
    ) {
      throw new ApiDomainError("CREDENTIAL_SERVICE_INVALID");
    }
    return Object.freeze({
      request: inspected.existing,
      statusToken: statusCredential.bearerToken
    });
  }

  const jobId = assertOpaqueId(dependencies.ids, "deletion-job");
  const statusCredential = assertIssuedCredential(
    await dependencies.credentials.issueDeletionStatus(jobId),
    "deletion-status"
  );
  if (
    !(await dependencies.credentials.verify(
      statusCredential.bearerToken,
      statusCredential.stored
    ))
  ) {
    throw new ApiDomainError("CREDENTIAL_SERVICE_INVALID");
  }
  const request: DeletionRequestRecord = Object.freeze({
    installationId: inspected.installation.installationId,
    idempotencyKey: authentication.idempotencyKey,
    jobId,
    state: "queued",
    statusCredential: statusCredential.stored,
    replayCredential: Object.freeze({
      ...authentication.candidate.credential
    }),
    requestedAt,
    completedAt: null,
    expiresAt: addUtcDays(requestedAt, 30),
    anonymousHistoricalTotalsRetained: true
  });
  await transaction.beginDeletion({ request, at: requestedAt });
  return Object.freeze({
    request,
    statusToken: statusCredential.bearerToken
  });
}

function toDeleteResult(input: {
  readonly request: DeletionRequestRecord;
  readonly statusToken: string;
}): DeleteResult {
  return Object.freeze({
    contractVersion: 1 as const,
    jobId: input.request.jobId,
    status: "queued" as const,
    statusToken: input.statusToken,
    requestedAt: input.request.requestedAt,
    anonymousHistoricalTotalsRetained:
      input.request.anonymousHistoricalTotalsRetained
  });
}

export async function requestContributorDeletion(
  command: DeleteCommand,
  dependencies: DeletionDependencies
): Promise<DeleteResult> {
  return sanitizeUnexpected(async () => {
    const requestedAt = canonicalNow(dependencies.clock);
    const rateLimitKey = assertRateLimitKey(command.rateLimitKey);
    const idempotencyKey = assertDeletionIdempotencyKey(
      command.idempotencyKey
    );
    await enforceRateLimit(
      dependencies.rateLimit,
      "delete",
      rateLimitKey,
      requestedAt
    );
    const initial = await authenticateCredential(
      command.bearerToken,
      "deletion",
      dependencies.credentials,
      dependencies.storage
    );
    const authentication: AuthenticatedDeletion = Object.freeze({
      bearerToken: initial.bearerToken,
      candidate: initial.candidate,
      idempotencyKey
    });

    const inspected = await dependencies.storage.withDeletionTransaction(
      initial.candidate.installationId,
      (transaction) =>
        inspectDeletionRequest(transaction, authentication, dependencies)
    );
    const derivedMarker = assertHmacSha256Digest(
      await dependencies.credentials.deriveSuppressionMarker(
        inspected.installation.installationId
      )
    );
    const ledgerRequestedAt =
      inspected.existing?.requestedAt ?? requestedAt;
    await dependencies.suppressionLedger.record({
      suppressionMarker: derivedMarker,
      recordedAt: requestedAt,
      expiresAt: addUtcDays(ledgerRequestedAt, 37)
    });

    const begun = await dependencies.storage.withDeletionTransaction(
      initial.candidate.installationId,
      (transaction) =>
        beginDeletionRequest(
          transaction,
          authentication,
          requestedAt,
          dependencies
        )
    );
    return toDeleteResult(begun);
  });
}

export async function completeContributorDeletion(
  command: CompleteDeletionCommand,
  dependencies: CompleteDeletionDependencies
): Promise<CompleteDeletionResult> {
  return sanitizeUnexpected(async () => {
    const jobId = assertDeletionJobId(command.jobId);
    const completedAt = canonicalNow(dependencies.clock);
    const completed = await dependencies.storage.completeDeletionAtomically({
      jobId,
      completedAt
    });
    if (
      completed.jobId !== jobId ||
      completed.state !== "complete" ||
      completed.completedAt === null
    ) {
      throw new ApiDomainError("SERVICE_UNAVAILABLE");
    }
    return Object.freeze({
      jobId,
      state: "complete" as const,
      completedAt: completed.completedAt,
      anonymousHistoricalTotalsRetained:
        completed.anonymousHistoricalTotalsRetained
    });
  });
}

function statusCredentialMatches(
  request: DeletionStatusRecord,
  candidate: CredentialCandidate
): boolean {
  const expected = request.statusCredential;
  const supplied = candidate.credential;
  return (
    candidate.installationId === request.installationId &&
    expected.scope === "deletion-status" &&
    supplied.scope === "deletion-status" &&
    supplied.publicTokenId === expected.publicTokenId &&
    supplied.hmacDigest === expected.hmacDigest &&
    supplied.hmacKeyId === expected.hmacKeyId
  );
}

export async function getContributorDeletionStatus(
  command: DeletionStatusCommand,
  dependencies: DeletionStatusDependencies
): Promise<DeletionStatusResult> {
  return sanitizeUnexpected(async () => {
    const jobId = assertDeletionJobId(command.jobId);
    const checkedAt = canonicalNow(dependencies.clock);
    const authenticated = await authenticateCredential(
      command.bearerToken,
      "deletion-status",
      dependencies.credentials,
      dependencies.storage
    );
    const request = await dependencies.storage.getDeletionJobStatus(jobId);
    const expiresAt = request === null
      ? Number.NaN
      : Date.parse(request.expiresAt);
    if (
      request === null ||
      request.jobId !== jobId ||
      !statusCredentialMatches(request, authenticated.candidate) ||
      !Number.isFinite(expiresAt) ||
      new Date(expiresAt).toISOString() !== request.expiresAt ||
      expiresAt <= Date.parse(checkedAt)
    ) {
      throw new ApiDomainError("TOKEN_INVALID");
    }

    const parsed = DeletionStatusResponseV1Schema.safeParse({
      contractVersion: 1,
      jobId: request.jobId,
      status: request.state,
      requestedAt: request.requestedAt,
      finishedAt: request.finishedAt,
      anonymousHistoricalTotalsRetained:
        request.anonymousHistoricalTotalsRetained
    });
    if (!parsed.success) {
      throw new ApiDomainError("SERVICE_UNAVAILABLE");
    }
    return Object.freeze(parsed.data);
  });
}

export async function replayDeletionSuppressions(
  dependencies: SuppressionReplayDependencies
): Promise<SuppressionReplayResult> {
  return sanitizeUnexpected(async () => {
    const at = canonicalNow(dependencies.clock);
    const entries = await dependencies.suppressionLedger.listActive(at);
    const activeMarkers = new Set(
      entries.map(({ suppressionMarker }) =>
        assertHmacSha256Digest(suppressionMarker)
      )
    );
    let purgedInstallations = 0;
    for await (const installationId of dependencies.storage.listRestoredInstallationIds()) {
      const validatedInstallationId = assertRestoredInstallationId(
        installationId
      );
      const marker = assertHmacSha256Digest(
        await dependencies.credentials.deriveSuppressionMarker(
          validatedInstallationId
        )
      );
      if (
        activeMarkers.has(marker) &&
        (await dependencies.storage.purgeRestoredInstallation(
          validatedInstallationId,
          at
        ))
      ) {
        purgedInstallations += 1;
      }
    }
    return Object.freeze({
      examinedMarkers: entries.length,
      purgedInstallations
    });
  });
}
