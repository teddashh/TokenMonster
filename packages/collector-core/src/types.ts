import type {
  CollectorIdentityV1,
  DailyAggregateBucketV1,
  IngestSnapshotV1
} from "@tokenmonster/contracts";
import type {
  Tier1Client,
  Tier1ToolScope
} from "@tokenmonster/collector-tokscale";
import type {
  CloudMirrorQuery,
  DailyAggregateQuery,
  DailyUpsertResult,
  DueCloudSnapshotQuery,
  EnqueueCloudSnapshotOptions,
  LocalStoreDiagnosticSummary,
  MissingCloudZeroCorrectionPlan,
  MissingCloudZeroCorrectionQuery,
  ProjectedDailyAggregate,
  QueuedCloudSnapshot,
  RescheduleCloudSnapshotInput,
  StoredCloudMirrorRow,
  StoredCollectorAuthority,
  StoredDailyAggregate
} from "@tokenmonster/local-store";

export const COLLECTOR_PROJECTION_BATCH_ID =
  "00000000-0000-4000-8000-000000000001" as const;

export const MAX_LOCAL_SCAN_ROWS = 1_000;
export const MAX_INGEST_BODY_BYTES = 65_536;

export interface DailyCollectorScanRequest {
  readonly client: Tier1Client;
  readonly utcDate: string;
  readonly generatedAt: string;
  readonly projectionBatchId: typeof COLLECTOR_PROJECTION_BATCH_ID;
  readonly projectionRevision: 1;
}

export type CompleteDailyCollectorScan = Readonly<{
  status: "complete";
  snapshot: IngestSnapshotV1 | null;
}>;

export type IncompleteDailyCollectorScan = Readonly<{
  status: "incomplete";
}>;

export type DailyCollectorScanOutcome =
  | CompleteDailyCollectorScan
  | IncompleteDailyCollectorScan;

export interface DailyCollectorPort {
  readonly identity: CollectorIdentityV1;
  scanDaily(input: DailyCollectorScanRequest): Promise<unknown>;
}

export type ContributionState =
  | Readonly<{ status: "disabled" }>
  | Readonly<{ status: "paused" }>
  | Readonly<{
      status: "active";
      consentDocumentRevision: string;
      currentDocumentRevision: string;
    }>;

export interface ContributionStatePort {
  readContributionState(): unknown | Promise<unknown>;
}

export interface LocalCollectorStorePort {
  getCollectorAuthority(): StoredCollectorAuthority | null;
  listDailyAggregates(
    input: DailyAggregateQuery
  ): readonly StoredDailyAggregate[];
  upsertDailyAggregates(
    input: readonly unknown[]
  ): readonly DailyUpsertResult[];
  listCloudMirror(input: CloudMirrorQuery): readonly StoredCloudMirrorRow[];
  planMissingCloudZeroCorrections(
    input: MissingCloudZeroCorrectionQuery
  ): MissingCloudZeroCorrectionPlan;
  enqueueCloudSnapshot(
    snapshot: unknown,
    options: EnqueueCloudSnapshotOptions
  ): "inserted" | "idempotent";
  listDueCloudSnapshots(
    input: DueCloudSnapshotQuery
  ): readonly QueuedCloudSnapshot[];
  rescheduleCloudSnapshot(input: RescheduleCloudSnapshotInput): boolean;
  getDiagnosticSummary(): LocalStoreDiagnosticSummary;
}

export interface LocalScanCoordinatorDependencies {
  readonly collector: DailyCollectorPort;
  readonly store: LocalCollectorStorePort;
  readonly contribution: ContributionStatePort;
  readonly clock: () => Date;
  readonly uuid: () => string;
}

export interface ExplicitDailyScanRequest {
  readonly client: Tier1Client;
  readonly utcDate: string;
}

export type CloudQueueSkippedReason =
  | "consent-not-current"
  | "contribution-disabled"
  | "contribution-paused"
  | "no-wire-changes";

export type CloudQueueBlockedReason =
  | "contribution-state-invalid"
  | "contribution-state-unavailable"
  | "identifier-unavailable"
  | "mirror-correction-invalid"
  | "mirror-correction-truncated"
  | "mirror-scope-too-large"
  | "mirror-unavailable"
  | "outbox-unavailable"
  | "payload-too-large"
  | "snapshot-invalid"
  | "too-many-wire-buckets";

export type CloudQueueResult =
  | Readonly<{
      status: "queued";
      batchId: string;
      generatedAt: string;
      bucketCount: number;
      payloadBytes: number;
    }>
  | Readonly<{
      status: "skipped";
      reason: CloudQueueSkippedReason;
    }>
  | Readonly<{
      status: "blocked";
      reason: CloudQueueBlockedReason;
    }>;

export interface LocalDailyScanResult {
  readonly status: "applied";
  readonly client: Tier1Client;
  readonly tool: Tier1ToolScope;
  readonly bucketStart: string;
  readonly complete: true;
  readonly observedRows: number;
  readonly appliedRows: number;
  readonly insertedRows: number;
  readonly updatedRows: number;
  readonly metadataUpdatedRows: number;
  readonly unchangedRows: number;
  readonly inferredZeroRows: number;
  readonly cloudQueue: CloudQueueResult;
}

export interface DueUploadQuery {
  readonly now: string;
  readonly limit: number;
}

export interface UploadRetryInput extends RescheduleCloudSnapshotInput {}

export type CoordinatorLastScanDiagnostic =
  | Readonly<{ status: "never" }>
  | Readonly<{
      status: "failed";
      code: string;
    }>
  | Readonly<{
      status: "applied";
      observedRows: number;
      appliedRows: number;
      inferredZeroRows: number;
      cloudQueueStatus: CloudQueueResult["status"];
      cloudQueueReason:
        | CloudQueueSkippedReason
        | CloudQueueBlockedReason
        | null;
    }>;

export interface CollectorCoreDiagnosticSummary {
  readonly schemaVersion: "1";
  readonly scanInProgress: boolean;
  readonly collector: CollectorIdentityV1;
  readonly lastScan: CoordinatorLastScanDiagnostic;
  readonly localStore:
    | Readonly<{ status: "unavailable" }>
    | Readonly<{
        status: "available";
        dailyAggregateCount: number;
        cloudMirrorCount: number;
        cloudOutboxCount: number;
        authorityConfigured: boolean;
        authorityRunning: boolean;
      }>;
}

export interface TokscaleDailyCollectorOptions {
  readonly configDir: string;
  readonly binaryPath?: string;
}

export interface PreparedLocalScan {
  readonly rows: readonly ProjectedDailyAggregate[];
  readonly presentBuckets: readonly DailyAggregateBucketV1[];
  readonly inferredZeroRows: number;
}
