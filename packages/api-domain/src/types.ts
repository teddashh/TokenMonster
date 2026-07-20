import type {
  DailyAggregateBucketV1,
  SupportedCollectorIdentity,
  SupportedCollectorKind,
  SupportedIngestSnapshot,
  TokenCountsV1,
  ValueQualityV1
} from "@tokenmonster/contracts";
import type { CanonicalHasher } from "@tokenmonster/usage-domain";

export type CredentialScope =
  | "upload"
  | "deletion"
  | "deletion-status"
  | "enrollment-recovery";
export type InstallationStatus = "active" | "paused" | "deleting" | "deleted";
export type RateLimitRoute = "enrollment" | "ingest" | "lifecycle" | "delete";
export type OpaqueIdKind = "installation" | "consent-event" | "deletion-job";

/** A base64url or hex encoding of exactly one HMAC-SHA-256 digest. */
export type HmacSha256Digest = string;

export interface StoredCredential {
  readonly scope: CredentialScope;
  readonly publicTokenId: string;
  readonly hmacDigest: HmacSha256Digest;
  readonly hmacKeyId: string;
}

export interface IssuedCredential {
  /** Transient secret. It must never be passed to a storage or logging port. */
  readonly bearerToken: string;
  readonly entropyBits: 256;
  readonly stored: StoredCredential;
}

export interface PresentedCredential {
  readonly publicTokenId: string;
}

export interface CredentialService {
  issue(scope: "upload" | "deletion"): Promise<IssuedCredential>;
  /**
   * Converts one canonical client-generated V2 bearer into verifier material.
   * The returned artifact must cryptographically bind the credential version
   * and scope. The raw bearer must remain transient and non-enumerable.
   */
  acceptPresentedV2(
    scope: "upload" | "deletion" | "enrollment-recovery",
    bearerToken: string
  ): Promise<StoredCredential>;
  /**
   * Deterministically issues the one scoped status credential for a deletion
   * job. Repeating the same jobId must return byte-identical bearer and stored
   * HMAC artifacts without persisting the raw bearer.
   */
  issueDeletionStatus(jobId: string): Promise<IssuedCredential>;
  inspect(bearerToken: string): Promise<PresentedCredential | null>;
  verify(
    bearerToken: string,
    expected: StoredCredential
  ): Promise<boolean>;
  deriveSuppressionMarker(
    installationId: string
  ): Promise<HmacSha256Digest>;
}

export interface Clock {
  now(): Date;
}

export interface OpaqueIdGenerator {
  generate(kind: OpaqueIdKind): string;
}

export interface ContributionPolicy {
  readonly currentConsentDocumentRevision: string;
  isCollectorSupported(collector: SupportedCollectorIdentity): boolean;
}

export interface RateLimitRequest {
  readonly route: RateLimitRoute;
  /** A non-reversible edge or contributor rate key, never a raw IP/token. */
  readonly subjectKey: string;
  readonly at: string;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds?: number;
}

export interface RateLimitPort {
  consume(request: RateLimitRequest): Promise<RateLimitDecision>;
}

export interface ConsentReceiptRecord {
  readonly eventId: string;
  readonly installationId: string;
  readonly purpose: "contribution";
  readonly documentRevision: string;
  readonly granted: true;
  readonly acknowledgedAt: string;
  readonly recordedAt: string;
}

export interface InstallationRecord {
  readonly installationId: string;
  readonly status: InstallationStatus;
  readonly consentDocumentRevision: string;
  readonly uploadCredential: StoredCredential | null;
  readonly deletionCredential: StoredCredential | null;
  readonly createdAt: string;
  readonly pausedAt: string | null;
  readonly deletingAt: string | null;
  readonly deletedAt: string | null;
}

export interface EnrollmentStoragePort {
  createEnrollmentAtomically(input: {
    readonly installation: InstallationRecord;
    readonly consentReceipt: ConsentReceiptRecord;
  }): Promise<void>;
}

export interface CredentialCandidate {
  readonly installationId: string;
  readonly credential: StoredCredential;
}

export interface CredentialLookupPort {
  findCredentialCandidate(
    scope: CredentialScope,
    publicTokenId: string
  ): Promise<CredentialCandidate | null>;
}

export interface EnrollmentCommand {
  readonly body: unknown;
  /** Supplied by the edge adapter after non-reversible prefix hashing. */
  readonly rateLimitKey: string;
}

export interface EnrollmentResult {
  readonly contractVersion: 1;
  readonly credentials: {
    readonly uploadToken: string;
    readonly deletionToken: string;
  };
  readonly consentReceipt: {
    readonly receiptId: string;
    readonly purpose: "contribution";
    readonly documentRevision: string;
    readonly granted: true;
    readonly acknowledgedAt: string;
    readonly recordedAt: string;
  };
  readonly acceptedSnapshotSchemaVersions: readonly ["1"];
}

export interface EnrollmentDependencies {
  readonly clock: Clock;
  readonly ids: OpaqueIdGenerator;
  readonly credentials: CredentialService;
  readonly policy: ContributionPolicy;
  readonly rateLimit: RateLimitPort;
  readonly storage: EnrollmentStoragePort;
}

export interface RecoverableEnrollmentRecord {
  readonly installation: InstallationRecord;
  readonly consentReceipt: ConsentReceiptRecord;
  readonly recoveryCredential: StoredCredential;
}

export interface RecoverableEnrollmentStoragePort {
  findRecoverableEnrollment(
    recoveryPublicTokenId: string
  ): Promise<RecoverableEnrollmentRecord | null>;
  createRecoverableEnrollmentAtomically(input: {
    readonly installation: InstallationRecord;
    readonly consentReceipt: ConsentReceiptRecord;
    readonly recoveryCredential: StoredCredential;
  }): Promise<void>;
}

export interface RecoverableEnrollmentCommand {
  readonly body: unknown;
  /** Supplied by the edge adapter after non-reversible prefix hashing. */
  readonly rateLimitKey: string;
}

export interface RecoverableEnrollmentResult {
  readonly contractVersion: 2;
  readonly status: "active";
  readonly consentReceipt: {
    readonly receiptId: string;
    readonly purpose: "contribution";
    readonly documentRevision: string;
    readonly granted: true;
    readonly acknowledgedAt: string;
    readonly recordedAt: string;
  };
  readonly acceptedSnapshotSchemaVersions: readonly ["1", "2"];
}

export interface RecoverableEnrollmentDependencies {
  readonly clock: Clock;
  readonly ids: OpaqueIdGenerator;
  readonly credentials: CredentialService;
  readonly policy: ContributionPolicy;
  readonly rateLimit: RateLimitPort;
  readonly storage: RecoverableEnrollmentStoragePort;
}

export interface IngestBatchSummary {
  readonly appliedBuckets: number;
  readonly staleBuckets: number;
  readonly idempotentBuckets: number;
  readonly quarantinedBuckets: number;
}

export interface IngestBatchReceiptRecord {
  readonly installationId: string;
  readonly batchId: string;
  readonly payloadHash: string;
  readonly receivedAt: string;
  readonly summary: IngestBatchSummary;
}

export interface AuthorityBindingRecord {
  readonly installationId: string;
  readonly bucketStart: string;
  readonly collectorKind: SupportedCollectorKind;
  readonly adapterVersion: string;
  readonly sourceVersion: string;
  readonly createdAt: string;
}

export interface CurrentUsageRowRecord {
  readonly key: string;
  readonly installationId: string;
  readonly bucketStart: string;
  readonly provider: DailyAggregateBucketV1["provider"];
  readonly modelFamily: string;
  readonly tool: string;
  readonly valueQuality: ValueQualityV1;
  readonly revision: number;
  readonly tokens: TokenCountsV1;
  readonly collector: SupportedCollectorIdentity;
  readonly rowHash: string;
  readonly updatedAt: string;
}

/**
 * The adapter must serialize this callback with all writes and roll it back if
 * the callback throws. Reads and writes in one callback are one transaction.
 */
export interface IngestTransactionPort {
  findCredentialCandidate(
    scope: "upload",
    publicTokenId: string
  ): Promise<CredentialCandidate | null>;
  getInstallation(): Promise<InstallationRecord | null>;
  getBatchReceipt(batchId: string): Promise<IngestBatchReceiptRecord | null>;
  getAuthorityBinding(
    bucketStart: string
  ): Promise<AuthorityBindingRecord | null>;
  getUsageRow(key: string): Promise<CurrentUsageRowRecord | null>;
  putAuthorityBinding(binding: AuthorityBindingRecord): Promise<void>;
  putUsageRow(row: CurrentUsageRowRecord): Promise<void>;
  putBatchReceipt(receipt: IngestBatchReceiptRecord): Promise<void>;
  markAggregateDirty(at: string): Promise<void>;
}

export interface IngestStoragePort extends CredentialLookupPort {
  withIngestTransaction<T>(
    installationId: string,
    operation: (transaction: IngestTransactionPort) => Promise<T>
  ): Promise<T>;
}

export interface IngestCommand {
  readonly bearerToken: string;
  readonly idempotencyKey: string;
  readonly snapshot: unknown;
  /** Non-reversible edge key; never pass the bearer credential here. */
  readonly rateLimitKey: string;
}

export interface IngestResult {
  readonly contractVersion: 1;
  readonly batchId: string;
  readonly receivedAt: string;
  readonly replayed: boolean;
  readonly status: "accepted" | "quarantined";
  readonly summary: IngestBatchSummary;
}

export interface IngestDependencies {
  readonly clock: Clock;
  readonly credentials: CredentialService;
  readonly policy: ContributionPolicy;
  readonly rateLimit: RateLimitPort;
  readonly storage: IngestStoragePort;
  readonly hasher?: CanonicalHasher;
}

/**
 * Pause and resume authenticate with the upload credential, then repeat that
 * verification inside the same optimistic transaction as the state change.
 */
export interface LifecycleTransactionPort {
  findCredentialCandidate(
    scope: "upload",
    publicTokenId: string
  ): Promise<CredentialCandidate | null>;
  getInstallation(): Promise<InstallationRecord | null>;
  getLatestGrantedConsentReceipt(
    documentRevision: string
  ): Promise<ConsentReceiptRecord | null>;
  pause(at: string): Promise<void>;
  resume(input: {
    readonly consentReceipt: ConsentReceiptRecord;
    readonly at: string;
  }): Promise<void>;
}

export interface LifecycleStoragePort extends CredentialLookupPort {
  withLifecycleTransaction<T>(
    installationId: string,
    operation: (transaction: LifecycleTransactionPort) => Promise<T>
  ): Promise<T>;
}

export interface PauseCommand {
  readonly bearerToken: string;
  /** Non-reversible upload-token rate key; never the bearer credential. */
  readonly rateLimitKey: string;
}

export interface PauseResult {
  readonly contractVersion: 1;
  readonly status: "paused";
  readonly pausedAt: string;
  readonly futureUploadsBlocked: true;
  readonly identifiableCurrentDataRetained: true;
  readonly anonymousHistoricalTotalsRetained: true;
}

export interface ResumeCommand {
  readonly bearerToken: string;
  readonly body: unknown;
  /** Non-reversible upload-token rate key; never the bearer credential. */
  readonly rateLimitKey: string;
}

export interface ResumeResult {
  readonly contractVersion: 1;
  readonly status: "active";
  readonly resumedAt: string;
  readonly consentReceipt: {
    readonly receiptId: string;
    readonly purpose: "contribution";
    readonly documentRevision: string;
    readonly granted: true;
    readonly acknowledgedAt: string;
    readonly recordedAt: string;
  };
}

interface LifecycleBaseDependencies {
  readonly clock: Clock;
  readonly credentials: CredentialService;
  readonly rateLimit: RateLimitPort;
  readonly storage: LifecycleStoragePort;
}

export type PauseDependencies = LifecycleBaseDependencies;

export interface ResumeDependencies extends LifecycleBaseDependencies {
  readonly ids: OpaqueIdGenerator;
  readonly policy: ContributionPolicy;
}

export type DeletionJobState = "queued" | "running" | "complete" | "failed";

export interface DeletionRequestRecord {
  readonly installationId: string;
  readonly idempotencyKey: string;
  readonly jobId: string;
  readonly state: DeletionJobState;
  readonly statusCredential: StoredCredential;
  /** Retained HMAC verifier only for authenticated idempotent replay. */
  readonly replayCredential: StoredCredential;
  readonly requestedAt: string;
  readonly completedAt: string | null;
  readonly expiresAt: string;
  readonly anonymousHistoricalTotalsRetained: true;
}

/** Status-read projection deliberately excludes idempotency/replay verifiers. */
export interface DeletionStatusRecord {
  readonly installationId: string;
  readonly jobId: string;
  readonly state: DeletionJobState;
  readonly statusCredential: StoredCredential;
  readonly requestedAt: string;
  readonly finishedAt: string | null;
  readonly expiresAt: string;
  readonly anonymousHistoricalTotalsRetained: true;
}

/**
 * beginDeletion must clear/revoke uploadCredential before it returns. Complete
 * must purge current usage, authority bindings, batches, shares, consent links,
 * and installation credentials, then dirty the public projection. Only the
 * deletion replay verifier and job-status verifier may remain until expiry.
 */
export interface DeletionTransactionPort {
  findCredentialCandidate(
    scope: "deletion",
    publicTokenId: string
  ): Promise<CredentialCandidate | null>;
  getInstallation(): Promise<InstallationRecord | null>;
  getDeletionRequest(
    idempotencyKey: string
  ): Promise<DeletionRequestRecord | null>;
  beginDeletion(input: {
    readonly request: DeletionRequestRecord;
    readonly at: string;
  }): Promise<void>;
}

export interface DeletionCompletionStoragePort {
  completeDeletionAtomically(input: {
    readonly jobId: string;
    readonly completedAt: string;
  }): Promise<DeletionRequestRecord>;
}

export interface DeletionStoragePort
  extends CredentialLookupPort,
    DeletionCompletionStoragePort {
  withDeletionTransaction<T>(
    installationId: string,
    operation: (transaction: DeletionTransactionPort) => Promise<T>
  ): Promise<T>;
  /** Streams opaque IDs from a restored primary backup before traffic opens. */
  listRestoredInstallationIds(): AsyncIterable<string>;
  /** Purges one restored installation and all attributable hot state. */
  purgeRestoredInstallation(
    installationId: string,
    at: string
  ): Promise<boolean>;
}

/** Least-privilege read surface used by the deletion-status endpoint. */
export interface DeletionStatusStoragePort extends CredentialLookupPort {
  getDeletionJobStatus(jobId: string): Promise<DeletionStatusRecord | null>;
}

/** Bounded operational surface used by a deletion maintenance processor. */
export interface DeletionMaintenanceStoragePort
  extends DeletionCompletionStoragePort {
  listQueuedDeletionJobIds(limit: number): Promise<readonly string[]>;
}

export interface SuppressionLedgerEntry {
  readonly suppressionMarker: HmacSha256Digest;
  readonly recordedAt: string;
  readonly expiresAt: string;
}

/** This port must be backed by storage independent from the primary database. */
export interface SuppressionLedgerPort {
  record(entry: SuppressionLedgerEntry): Promise<void>;
  listActive(at: string): Promise<readonly SuppressionLedgerEntry[]>;
}

export interface DeleteCommand {
  readonly bearerToken: string;
  readonly idempotencyKey: string;
  /** Non-reversible edge key; deletion has a quota independent from ingest. */
  readonly rateLimitKey: string;
}

export interface DeleteResult {
  readonly contractVersion: 1;
  readonly jobId: string;
  readonly status: "queued";
  readonly statusToken: string;
  readonly requestedAt: string;
  readonly anonymousHistoricalTotalsRetained: true;
}

export interface DeletionDependencies {
  readonly clock: Clock;
  readonly ids: OpaqueIdGenerator;
  readonly credentials: CredentialService;
  readonly rateLimit: RateLimitPort;
  readonly storage: DeletionStoragePort;
  readonly suppressionLedger: SuppressionLedgerPort;
}

export interface DeletionStatusCommand {
  readonly bearerToken: string;
  readonly jobId: string;
}

export interface DeletionStatusResult {
  readonly contractVersion: 1;
  readonly jobId: string;
  readonly status: DeletionJobState;
  readonly requestedAt: string;
  readonly finishedAt: string | null;
  readonly anonymousHistoricalTotalsRetained: true;
}

export interface DeletionStatusDependencies {
  readonly clock: Clock;
  readonly credentials: CredentialService;
  readonly storage: DeletionStatusStoragePort;
}

export interface CompleteDeletionCommand {
  readonly jobId: string;
}

export interface CompleteDeletionDependencies {
  readonly clock: Clock;
  readonly storage: DeletionCompletionStoragePort;
}

export interface CompleteDeletionResult {
  readonly jobId: string;
  readonly state: "complete";
  readonly completedAt: string;
  readonly anonymousHistoricalTotalsRetained: boolean;
}

export interface SuppressionReplayResult {
  readonly examinedMarkers: number;
  readonly purgedInstallations: number;
}

export interface SuppressionReplayDependencies {
  readonly clock: Clock;
  readonly credentials: Pick<CredentialService, "deriveSuppressionMarker">;
  readonly storage: Pick<
    DeletionStoragePort,
    "listRestoredInstallationIds" | "purgeRestoredInstallation"
  >;
  readonly suppressionLedger: Pick<SuppressionLedgerPort, "listActive">;
}

export type ParsedEnrollmentConsent = {
  readonly contractVersion: 1;
  readonly consent: {
    readonly purpose: "contribution";
    readonly documentRevision: string;
    readonly granted: true;
    readonly acknowledgedAt: string;
  };
};

export type ValidatedIngestSnapshot = SupportedIngestSnapshot;
