import type {
  DailyAggregateBucketV1,
  SupportedIngestSnapshot
} from "@tokenmonster/contracts";
import {
  UsageDomainError,
  hashIngestBatch,
  hashServerRow
} from "@tokenmonster/usage-domain";

import {
  assertCandidateValid,
  authenticateCredential
} from "./auth.js";
import { ApiDomainError, sanitizeUnexpected } from "./errors.js";
import type {
  AuthorityBindingRecord,
  CurrentUsageRowRecord,
  IngestBatchReceiptRecord,
  IngestBatchSummary,
  IngestCommand,
  IngestDependencies,
  IngestResult,
  IngestTransactionPort,
  InstallationRecord
} from "./types.js";
import {
  assertBucketFreshness,
  assertCurrentConsent,
  assertIngestIdempotencyKey,
  assertRateLimitKey,
  canonicalNow,
  enforceRateLimit,
  parseIngestSnapshot
} from "./validation.js";

type BucketDecision = Readonly<{
  status: "insert" | "replace" | "stale" | "idempotent";
  row: CurrentUsageRowRecord;
}>;

function usageKey(
  installationId: string,
  bucket: DailyAggregateBucketV1
): string {
  return [
    installationId,
    bucket.bucketStart,
    bucket.provider,
    bucket.modelFamily,
    bucket.tool
  ].join("\u001f");
}

function assertInstallationCanIngest(
  installation: InstallationRecord | null,
  installationId: string,
  currentConsentRevision: string
): asserts installation is InstallationRecord {
  if (
    installation === null ||
    installation.installationId !== installationId
  ) {
    throw new ApiDomainError("TOKEN_INVALID");
  }
  switch (installation.status) {
    case "active":
      break;
    case "paused":
      throw new ApiDomainError("INSTALLATION_PAUSED");
    case "deleting":
      throw new ApiDomainError("INSTALLATION_DELETING");
    case "deleted":
      throw new ApiDomainError("INSTALLATION_DELETED");
  }
  assertCurrentConsent(
    installation.consentDocumentRevision,
    currentConsentRevision
  );
}

function assertAuthorityCompatible(
  existing: AuthorityBindingRecord,
  snapshot: SupportedIngestSnapshot
): void {
  if (
    existing.collectorKind !== snapshot.collector.kind ||
    existing.adapterVersion !== snapshot.collector.adapterVersion ||
    existing.sourceVersion !== snapshot.collector.sourceVersion
  ) {
    throw new ApiDomainError("AUTHORITY_CONFLICT");
  }
}

function summarize(decisions: readonly BucketDecision[]): IngestBatchSummary {
  return Object.freeze({
    appliedBuckets: decisions.filter(
      ({ status }) => status === "insert" || status === "replace"
    ).length,
    staleBuckets: decisions.filter(({ status }) => status === "stale").length,
    idempotentBuckets: decisions.filter(
      ({ status }) => status === "idempotent"
    ).length,
    quarantinedBuckets: 0
  });
}

async function createIncomingRow(
  installationId: string,
  snapshot: SupportedIngestSnapshot,
  bucket: DailyAggregateBucketV1,
  receivedAt: string,
  hasher: IngestDependencies["hasher"]
): Promise<CurrentUsageRowRecord> {
  const rowHash = await hashServerRow(
    { enrollmentId: installationId },
    snapshot.collector,
    bucket,
    hasher
  );
  return Object.freeze({
    key: usageKey(installationId, bucket),
    installationId,
    bucketStart: bucket.bucketStart,
    provider: bucket.provider,
    modelFamily: bucket.modelFamily,
    tool: bucket.tool,
    valueQuality: bucket.valueQuality,
    revision: bucket.revision,
    tokens: Object.freeze({ ...bucket.tokens }),
    collector: Object.freeze({ ...snapshot.collector }),
    rowHash,
    updatedAt: receivedAt
  });
}

async function decideBucket(
  transaction: IngestTransactionPort,
  incoming: CurrentUsageRowRecord
): Promise<BucketDecision> {
  const existing = await transaction.getUsageRow(incoming.key);
  if (existing === null) {
    return Object.freeze({ status: "insert", row: incoming });
  }
  if (incoming.revision > existing.revision) {
    return Object.freeze({ status: "replace", row: incoming });
  }
  if (incoming.revision < existing.revision) {
    return Object.freeze({ status: "stale", row: incoming });
  }
  if (incoming.rowHash === existing.rowHash) {
    return Object.freeze({ status: "idempotent", row: incoming });
  }
  throw new ApiDomainError("REVISION_CONFLICT");
}

function toResult(
  receipt: IngestBatchReceiptRecord,
  replayed: boolean
): IngestResult {
  return Object.freeze({
    contractVersion: 1 as const,
    batchId: receipt.batchId,
    receivedAt: receipt.receivedAt,
    replayed,
    status:
      receipt.summary.quarantinedBuckets === 0
        ? ("accepted" as const)
        : ("quarantined" as const),
    summary: receipt.summary
  });
}

async function executeTransaction(
  transaction: IngestTransactionPort,
  input: {
    readonly installationId: string;
    readonly publicTokenId: string;
    readonly bearerToken: string;
    readonly snapshot: SupportedIngestSnapshot;
    readonly payloadHash: string;
    readonly receivedAt: string;
  },
  dependencies: IngestDependencies
): Promise<IngestResult> {
  const currentCandidate = await transaction.findCredentialCandidate(
    "upload",
    input.publicTokenId
  );
  await assertCandidateValid(
    input.bearerToken,
    "upload",
    input.publicTokenId,
    currentCandidate,
    dependencies.credentials
  );
  const installation = await transaction.getInstallation();
  assertInstallationCanIngest(
    installation,
    input.installationId,
    dependencies.policy.currentConsentDocumentRevision
  );

  const existingReceipt = await transaction.getBatchReceipt(
    input.snapshot.batchId
  );
  if (existingReceipt !== null) {
    if (existingReceipt.payloadHash !== input.payloadHash) {
      throw new ApiDomainError("BATCH_ID_REUSE");
    }
    return toResult(existingReceipt, true);
  }

  const authorityInserts: AuthorityBindingRecord[] = [];
  const seenDays = new Set<string>();
  for (const bucket of input.snapshot.buckets) {
    if (seenDays.has(bucket.bucketStart)) continue;
    seenDays.add(bucket.bucketStart);
    const existing = await transaction.getAuthorityBinding(bucket.bucketStart);
    if (existing !== null) {
      assertAuthorityCompatible(existing, input.snapshot);
    } else {
      authorityInserts.push(
        Object.freeze({
          installationId: input.installationId,
          bucketStart: bucket.bucketStart,
          collectorKind: input.snapshot.collector.kind,
          adapterVersion: input.snapshot.collector.adapterVersion,
          sourceVersion: input.snapshot.collector.sourceVersion,
          createdAt: input.receivedAt
        })
      );
    }
  }

  const decisions: BucketDecision[] = [];
  for (const bucket of input.snapshot.buckets) {
    const incoming = await createIncomingRow(
      input.installationId,
      input.snapshot,
      bucket,
      input.receivedAt,
      dependencies.hasher
    );
    decisions.push(await decideBucket(transaction, incoming));
  }
  const summary = summarize(decisions);
  const receipt: IngestBatchReceiptRecord = Object.freeze({
    installationId: input.installationId,
    batchId: input.snapshot.batchId,
    payloadHash: input.payloadHash,
    receivedAt: input.receivedAt,
    summary
  });

  for (const binding of authorityInserts) {
    await transaction.putAuthorityBinding(binding);
  }
  for (const decision of decisions) {
    if (decision.status === "insert" || decision.status === "replace") {
      await transaction.putUsageRow(decision.row);
    }
  }
  await transaction.putBatchReceipt(receipt);
  if (summary.appliedBuckets > 0) {
    await transaction.markAggregateDirty(input.receivedAt);
  }
  return toResult(receipt, false);
}

function translateHashError(error: unknown): never {
  if (error instanceof UsageDomainError) {
    throw new ApiDomainError("SERVICE_UNAVAILABLE");
  }
  throw error;
}

export async function ingestSnapshot(
  command: IngestCommand,
  dependencies: IngestDependencies
): Promise<IngestResult> {
  return sanitizeUnexpected(async () => {
    const receivedAt = canonicalNow(dependencies.clock);
    const rateLimitKey = assertRateLimitKey(command.rateLimitKey);
    await enforceRateLimit(
      dependencies.rateLimit,
      "ingest",
      rateLimitKey,
      receivedAt
    );
    const authentication = await authenticateCredential(
      command.bearerToken,
      "upload",
      dependencies.credentials,
      dependencies.storage
    );
    const snapshot = parseIngestSnapshot(command.snapshot);
    assertIngestIdempotencyKey(command.idempotencyKey, snapshot.batchId);
    if (!dependencies.policy.isCollectorSupported(snapshot.collector)) {
      throw new ApiDomainError("COLLECTOR_UNSUPPORTED");
    }
    assertBucketFreshness(snapshot, receivedAt);

    let payloadHash: string;
    try {
      payloadHash = await hashIngestBatch(snapshot, dependencies.hasher);
    } catch (error: unknown) {
      translateHashError(error);
    }

    return dependencies.storage.withIngestTransaction(
      authentication.candidate.installationId,
      (transaction) =>
        executeTransaction(
          transaction,
          {
            installationId: authentication.candidate.installationId,
            publicTokenId:
              authentication.candidate.credential.publicTokenId,
            bearerToken: authentication.bearerToken,
            snapshot,
            payloadHash,
            receivedAt
          },
          dependencies
        )
    );
  });
}
