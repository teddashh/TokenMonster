import type {
  CollectorIdentityV1,
  CollectorKindV1,
  DailyAggregateBucketV1,
  ProviderKindV1,
  TokenCountsV1,
  ValueQualityV1
} from "@tokenmonster/contracts";

export type EnrollmentId = string;
export type CanonicalUsageKey = string;
export type CanonicalAuthorityKey = string;
export type CanonicalBatchReceiptKey = string;
export type AnonymousRollupKey = string;

export interface AuthenticatedEnrollment {
  readonly enrollmentId: EnrollmentId;
}

export interface CanonicalUsageRow {
  readonly key: CanonicalUsageKey;
  readonly enrollmentId: EnrollmentId;
  readonly bucketStart: string;
  readonly provider: ProviderKindV1;
  readonly modelFamily: string;
  readonly tool: string;
  readonly valueQuality: ValueQualityV1;
  readonly revision: number;
  readonly tokens: TokenCountsV1;
  readonly collector: CollectorIdentityV1;
  readonly rowHash: string;
}

export interface AuthorityBinding {
  readonly key: CanonicalAuthorityKey;
  readonly enrollmentId: EnrollmentId;
  readonly bucketStart: string;
  readonly collectorKind: CollectorKindV1;
  readonly adapterVersion: string;
  readonly sourceVersion: string;
}

export interface IngestDecisionSummary {
  readonly appliedBuckets: number;
  readonly staleBuckets: number;
  readonly idempotentBuckets: number;
  readonly quarantinedBuckets: number;
}

export interface BatchReceipt {
  readonly key: CanonicalBatchReceiptKey;
  readonly enrollmentId: EnrollmentId;
  readonly batchId: string;
  readonly payloadHash: string;
  readonly receivedAt: string;
  readonly summary: IngestDecisionSummary;
}

export type BucketDecisionStatus =
  | "insert"
  | "replace"
  | "idempotent"
  | "stale";

export interface BucketDecision {
  readonly bucketIndex: number;
  readonly key: CanonicalUsageKey;
  readonly status: BucketDecisionStatus;
  readonly incoming: CanonicalUsageRow;
}

export interface ApplyIngestPlan {
  readonly kind: "apply";
  readonly expectedStateVersion: number;
  readonly payloadHash: string;
  readonly decisions: readonly BucketDecision[];
  readonly rowUpserts: readonly CanonicalUsageRow[];
  readonly authorityInserts: readonly AuthorityBinding[];
  readonly receipt: BatchReceipt;
}

export interface ReplayIngestPlan {
  readonly kind: "replay";
  readonly expectedStateVersion: number;
  readonly payloadHash: string;
  readonly decisions: readonly BucketDecision[];
  readonly receipt: BatchReceipt;
}

export type IngestBatchPlan = ApplyIngestPlan | ReplayIngestPlan;

export interface PublicTokenLedger {
  readonly input: string;
  readonly output: string;
  readonly cacheRead: string;
  readonly cacheWrite: string;
  readonly reasoning: string;
  readonly other: string;
  readonly total: string;
}

export interface AnonymousCoarseRollup {
  readonly key: AnonymousRollupKey;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly scope: "all";
  readonly compactionVersion: "1";
  readonly eligibleContributorCount: number;
  readonly tokens: PublicTokenLedger;
}

export interface UsageDomainState {
  readonly version: number;
  readonly rows: ReadonlyMap<CanonicalUsageKey, CanonicalUsageRow>;
  readonly authorityBindings: ReadonlyMap<
    CanonicalAuthorityKey,
    AuthorityBinding
  >;
  readonly batchReceipts: ReadonlyMap<CanonicalBatchReceiptKey, BatchReceipt>;
  readonly anonymousRollups: ReadonlyMap<
    AnonymousRollupKey,
    AnonymousCoarseRollup
  >;
}

export interface ExecuteIngestResult {
  readonly state: UsageDomainState;
  readonly receipt: BatchReceipt;
  readonly decisions: readonly BucketDecision[];
  readonly replayed: boolean;
}

export interface PublicAggregateProjection {
  readonly current: PublicTokenLedger;
  readonly anonymous: PublicTokenLedger;
  readonly allTime: PublicTokenLedger;
  readonly activeCurrentContributors: string;
}

export interface CompactionGroupDecision {
  readonly periodStart: string;
  readonly action: "rollup" | "drop";
  readonly rowCount: number;
  readonly uniqueEnrollmentCount: number;
}

export interface ThirtyDayCompactionPlan {
  readonly expectedStateVersion: number;
  readonly asOf: string;
  readonly deleteRowKeys: readonly CanonicalUsageKey[];
  readonly deleteAuthorityKeys: readonly CanonicalAuthorityKey[];
  readonly deleteBatchReceiptKeys: readonly CanonicalBatchReceiptKey[];
  readonly rollups: readonly AnonymousCoarseRollup[];
  readonly groups: readonly CompactionGroupDecision[];
}

export interface EnrollmentDeletionPlan {
  readonly expectedStateVersion: number;
  readonly enrollmentId: EnrollmentId;
  readonly deleteRowKeys: readonly CanonicalUsageKey[];
  readonly deleteAuthorityKeys: readonly CanonicalAuthorityKey[];
  readonly deleteBatchReceiptKeys: readonly CanonicalBatchReceiptKey[];
  readonly anonymousHistoricalTotalsRetained: boolean;
}

export type CanonicalBucketInput = DailyAggregateBucketV1;
