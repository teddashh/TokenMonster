import type {
  CollectorIdentityV1,
  DailyAggregateBucketV1,
  IngestReceiptV1,
  IngestSnapshotV1,
  ProviderKindV1,
  TokenCountsV1,
  ValueQualityV1,
} from "@tokenmonster/contracts";
import type {
  MonsterCharacterIdV1,
  MonsterStateV1,
} from "@tokenmonster/monster-engine";

export type LocalCoverage = "complete" | "partial" | "unknown";

export const COMPLETE_SCAN_CLIENTS = [
  "claude",
  "codex",
  "gemini",
  "grok",
] as const;

export type CompleteScanClient = (typeof COMPLETE_SCAN_CLIENTS)[number];

export interface CompleteDailyScanInput {
  readonly utcDate: string;
  readonly client: CompleteScanClient;
}

export interface StoredCompleteDailyScan extends CompleteDailyScanInput {
  readonly completedAt: string;
}

export interface CompleteDailyScanCoverageQuery {
  readonly utcDate: string;
}

export interface CompleteDailyScanCoverage {
  readonly utcDate: string;
  readonly completedClients: readonly CompleteScanClient[];
  readonly complete: boolean;
}

export interface ProjectedDailyAggregate {
  readonly bucketStart: string;
  readonly provider: ProviderKindV1;
  readonly modelFamily: string;
  readonly tool: string;
  readonly valueQuality: ValueQualityV1;
  readonly tokens: TokenCountsV1;
  readonly localCoverage: LocalCoverage;
  readonly collector: CollectorIdentityV1;
}

export interface StoredDailyAggregate extends ProjectedDailyAggregate {
  readonly revision: number;
  readonly updatedAt: string;
}

export type DailyUpsertStatus =
  "inserted" | "updated" | "metadata-updated" | "unchanged";

export interface DailyUpsertResult {
  readonly status: DailyUpsertStatus;
  readonly row: StoredDailyAggregate;
}

export interface DailyAggregateQuery {
  readonly fromInclusive?: string;
  readonly toExclusive?: string;
  readonly limit: number;
}

export const LOCAL_USAGE_INSIGHT_WINDOWS = [7, 28] as const;

export type LocalUsageInsightWindowDays =
  (typeof LOCAL_USAGE_INSIGHT_WINDOWS)[number];

export const LOCAL_USAGE_INSIGHT_TOOLS = [
  "claude-code",
  "codex-cli",
  "gemini-cli",
  "grok-build",
  "other",
] as const;

export type LocalUsageInsightTool =
  (typeof LOCAL_USAGE_INSIGHT_TOOLS)[number];

export interface LocalUsageInsightsQuery {
  readonly windowDays: LocalUsageInsightWindowDays;
}

export interface LocalUsageProviderInsight {
  readonly id: ProviderKindV1;
  readonly totalTokens: string;
  readonly shareBasisPoints: number;
}

export interface LocalUsageToolInsight {
  readonly id: LocalUsageInsightTool;
  readonly totalTokens: string;
  readonly shareBasisPoints: number;
}

/**
 * Bounded, content-blind renderer projection. It intentionally excludes model
 * families, collector metadata, identifiers, paths, and raw source strings.
 */
export interface LocalUsageInsightsV1 {
  readonly schemaVersion: "1";
  readonly windowDays: LocalUsageInsightWindowDays;
  readonly fromInclusive: string;
  readonly toExclusive: string;
  readonly totalTokens: string;
  readonly providers: readonly LocalUsageProviderInsight[];
  readonly tools: readonly LocalUsageToolInsight[];
}

export interface CloudMirrorReceiptReference {
  readonly batchId: string;
  readonly receivedAt: string;
}

export interface StoredCloudMirrorRow {
  readonly bucket: DailyAggregateBucketV1;
  readonly collector: CollectorIdentityV1;
  readonly receipt: CloudMirrorReceiptReference;
  readonly updatedAt: string;
}

export type CloudMirrorRecordStatus = "inserted" | "updated" | "idempotent";

export interface CloudMirrorRecordDecision {
  readonly status: CloudMirrorRecordStatus;
  readonly row: StoredCloudMirrorRow;
}

export interface RecordAcceptedCloudSnapshotResult {
  readonly receipt: IngestReceiptV1;
  readonly decisions: readonly CloudMirrorRecordDecision[];
}

export interface CloudMirrorQuery {
  readonly fromInclusive?: string;
  readonly toExclusive?: string;
  readonly limit: number;
}

export interface CloudMirrorClearQuery {
  readonly beforeExclusive?: string;
  readonly limit: number;
}

export interface CloudMirrorPresenceKey {
  readonly provider: ProviderKindV1;
  readonly modelFamily: string;
  readonly tool: string;
}

export interface MissingCloudZeroCorrectionQuery {
  readonly bucketStart: string;
  /** Caller attests presentKeys came from one complete authoritative scan. */
  readonly completeScan: true;
  readonly collector: CollectorIdentityV1;
  readonly presentKeys: readonly CloudMirrorPresenceKey[];
  readonly limit: number;
}

export interface PlannedCloudZeroCorrection {
  readonly bucket: DailyAggregateBucketV1;
  readonly collector: CollectorIdentityV1;
}

export interface MissingCloudZeroCorrectionPlan {
  readonly corrections: readonly PlannedCloudZeroCorrection[];
  readonly truncated: boolean;
}

export const COLLECTOR_AUTHORITY_STATES = [
  "stopped",
  "starting",
  "running",
  "stopping",
  "degraded",
  "switch-preview",
] as const;

export type CollectorAuthorityState =
  (typeof COLLECTOR_AUTHORITY_STATES)[number];

export interface CollectorAuthorityInput extends CollectorIdentityV1 {
  readonly state: CollectorAuthorityState;
}

export interface StoredCollectorAuthority extends CollectorAuthorityInput {
  readonly updatedAt: string;
}

export interface LocalCompanionConfigV1 {
  readonly schemaVersion: "1";
  readonly locale: "zh-TW" | "en";
  readonly timezone: string;
  readonly selectedCharacterId: MonsterCharacterIdV1;
  readonly collectionIntervalMinutes: 15 | 30 | 60;
  readonly startAtLogin: boolean;
  readonly animationsEnabled: boolean;
}

export interface MonsterSnapshotInput {
  readonly state: MonsterStateV1;
  readonly asOfRevision: number;
}

export interface StoredMonsterSnapshot extends MonsterSnapshotInput {
  readonly updatedAt: string;
}

export type MonsterUpsertStatus =
  "inserted" | "updated" | "stale" | "unchanged";

export interface MonsterUpsertResult {
  readonly status: MonsterUpsertStatus;
  readonly snapshot: StoredMonsterSnapshot;
}

export interface EnqueueCloudSnapshotOptions {
  readonly nextAttemptAt: string;
  readonly expiresAt: string;
}

export interface QueuedCloudSnapshot {
  readonly snapshot: IngestSnapshotV1;
  readonly attempts: number;
  readonly nextAttemptAt: string;
  readonly expiresAt: string;
  readonly lastErrorCode: CloudOutboxErrorCode | null;
}

export const CLOUD_OUTBOX_ERROR_CODES = [
  "network",
  "timeout",
  "rate-limited",
  "server-unavailable",
  "clock-skew",
] as const;

export type CloudOutboxErrorCode = (typeof CLOUD_OUTBOX_ERROR_CODES)[number];

export interface RescheduleCloudSnapshotInput {
  readonly batchId: string;
  readonly nextAttemptAt: string;
  readonly errorCode: CloudOutboxErrorCode;
}

export interface DueCloudSnapshotQuery {
  readonly now: string;
  readonly limit: number;
}

export interface LocalStoreDiagnosticSummary {
  readonly schemaVersion: number;
  readonly storage: "memory" | "file";
  readonly journalMode: "memory" | "wal";
  readonly securityPragmas: {
    readonly foreignKeys: true;
    readonly busyTimeoutMs: 5_000;
    readonly secureDelete: true;
  };
  readonly counts: {
    readonly dailyAggregates: number;
    readonly completeScanScopes: number;
    readonly cloudMirrorEntries: number;
    readonly monsterSnapshots: number;
    readonly cloudOutboxEntries: number;
  };
  readonly configConfigured: boolean;
  readonly collectorAuthority:
    | {
        readonly configured: false;
      }
    | {
        readonly configured: true;
        readonly kind: CollectorIdentityV1["kind"];
        readonly state: CollectorAuthorityState;
        readonly adapterVersion: string;
        readonly sourceVersion: string;
      };
}

export interface ContentBlindExportOptions {
  readonly maxDailyRows: number;
}

export interface LocalContentBlindExportV1 {
  readonly schemaVersion: "1";
  readonly exportedAt: string;
  readonly dailyAggregates: readonly StoredDailyAggregate[];
  readonly dailyAggregatesTruncated: boolean;
  readonly monsterSnapshots: readonly StoredMonsterSnapshot[];
  readonly config: LocalCompanionConfigV1 | null;
  readonly collectorAuthority: StoredCollectorAuthority | null;
}

export interface OpenLocalStoreOptions {
  readonly path: string;
  readonly clock?: () => Date;
}

export type DailyBucketWireProjection = Omit<
  DailyAggregateBucketV1,
  "revision"
>;
