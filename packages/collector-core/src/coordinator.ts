import {
  CollectorIdentityV1Schema,
  DailyAggregateBucketV1Schema,
  MAX_INGEST_BUCKETS_V1,
  type CollectorIdentityV1,
  type DailyAggregateBucketV1,
  type IngestSnapshotV1,
  type TokenCountsV1
} from "@tokenmonster/contracts";
import { toolScopeForTier1Client } from "@tokenmonster/collector-tokscale";
import type {
  DailyUpsertResult,
  ProjectedDailyAggregate,
  QueuedCloudSnapshot,
  StoredCloudMirrorRow,
  StoredDailyAggregate
} from "@tokenmonster/local-store";
import {
  canonicalSerializeIngestBatch,
  parseStrictIngestSnapshot
} from "@tokenmonster/usage-domain";

import {
  CollectorCoreError,
  collectorCoreFailure
} from "./errors.js";
import { TOKSCALE_COLLECTOR_IDENTITY } from "./tokscale.js";
import type {
  CloudQueueBlockedReason,
  CloudQueueResult,
  CollectorCoreDiagnosticSummary,
  CoordinatorLastScanDiagnostic,
  DailyCollectorPort,
  DueUploadQuery,
  ExplicitDailyScanRequest,
  LocalCollectorStorePort,
  LocalDailyScanResult,
  LocalScanCoordinatorDependencies,
  PreparedLocalScan,
  UploadRetryInput
} from "./types.js";
import {
  parseCollectorScanOutcome,
  parseContributionState,
  parseDueUploadQuery,
  parseExactCollectorIdentity,
  parseExplicitDailyScanRequest,
  parseUploadRetryInput,
  parseUuid,
  projectedRowToBucket,
  sameBucketProjection,
  sameCollectorIdentity,
  storedRowToBucket
} from "./validation.js";
import {
  COLLECTOR_PROJECTION_BATCH_ID,
  MAX_INGEST_BODY_BYTES,
  MAX_LOCAL_SCAN_ROWS
} from "./types.js";

const THIRTY_DAYS_MS = 30 * 86_400_000;

const ZERO_TOKENS: TokenCountsV1 = Object.freeze({
  input: "0",
  output: "0",
  cacheRead: "0",
  cacheWrite: "0",
  reasoning: "0",
  other: "0",
  total: "0"
});

function bucketKey(
  bucket: Pick<
    DailyAggregateBucketV1,
    "bucketStart" | "provider" | "modelFamily" | "tool"
  >
): string {
  return [
    bucket.bucketStart,
    bucket.provider,
    bucket.modelFamily,
    bucket.tool
  ].join("|");
}

function presenceKey(
  bucket: Pick<DailyAggregateBucketV1, "provider" | "modelFamily" | "tool">
): string {
  return [bucket.provider, bucket.modelFamily, bucket.tool].join("|");
}

function sameWireValue(
  left: DailyAggregateBucketV1,
  right: DailyAggregateBucketV1
): boolean {
  return (
    left.valueQuality === right.valueQuality &&
    left.tokens.input === right.tokens.input &&
    left.tokens.output === right.tokens.output &&
    left.tokens.cacheRead === right.tokens.cacheRead &&
    left.tokens.cacheWrite === right.tokens.cacheWrite &&
    left.tokens.reasoning === right.tokens.reasoning &&
    left.tokens.other === right.tokens.other &&
    left.tokens.total === right.tokens.total
  );
}

function nextUtcBucket(bucketStart: string): string {
  return new Date(Date.parse(bucketStart) + 86_400_000).toISOString();
}

function asProjection(
  bucket: DailyAggregateBucketV1,
  collector: CollectorIdentityV1
): ProjectedDailyAggregate {
  return Object.freeze({
    bucketStart: bucket.bucketStart,
    provider: bucket.provider,
    modelFamily: bucket.modelFamily,
    tool: bucket.tool,
    valueQuality: bucket.valueQuality,
    tokens: Object.freeze({ ...bucket.tokens }),
    localCoverage: "complete" as const,
    collector
  });
}

function cloudBlocked(reason: CloudQueueBlockedReason): CloudQueueResult {
  return Object.freeze({ status: "blocked", reason });
}

function sanitizeUnexpected(error: unknown): CollectorCoreError {
  return error instanceof CollectorCoreError
    ? error
    : new CollectorCoreError("COLLECTOR_FAILED");
}

function countsFromResults(results: readonly DailyUpsertResult[]): {
  readonly insertedRows: number;
  readonly updatedRows: number;
  readonly metadataUpdatedRows: number;
  readonly unchangedRows: number;
} {
  return Object.freeze({
    insertedRows: results.filter(({ status }) => status === "inserted").length,
    updatedRows: results.filter(({ status }) => status === "updated").length,
    metadataUpdatedRows: results.filter(
      ({ status }) => status === "metadata-updated"
    ).length,
    unchangedRows: results.filter(({ status }) => status === "unchanged").length
  });
}

function validateStoredRows(
  input: readonly StoredDailyAggregate[],
  bucketStart: string
): readonly StoredDailyAggregate[] {
  if (!Array.isArray(input) || input.length >= MAX_LOCAL_SCAN_ROWS) {
    return collectorCoreFailure("LOCAL_SCOPE_TOO_LARGE");
  }
  try {
    for (const row of input) {
      const bucket = storedRowToBucket(row);
      if (bucket.bucketStart !== bucketStart) {
        return collectorCoreFailure("LOCAL_APPLY_FAILED");
      }
      if (
        row.localCoverage !== "complete" &&
        row.localCoverage !== "partial" &&
        row.localCoverage !== "unknown"
      ) {
        return collectorCoreFailure("LOCAL_APPLY_FAILED");
      }
      const parsedCollector = CollectorIdentityV1Schema.safeParse(row.collector);
      if (!parsedCollector.success) {
        return collectorCoreFailure("LOCAL_APPLY_FAILED");
      }
    }
  } catch {
    return collectorCoreFailure("LOCAL_APPLY_FAILED");
  }
  return input;
}

function validateApplyResults(
  input: readonly DailyUpsertResult[],
  expected: readonly ProjectedDailyAggregate[]
): readonly DailyUpsertResult[] {
  if (!Array.isArray(input) || input.length !== expected.length) {
    return collectorCoreFailure("LOCAL_APPLY_FAILED");
  }
  try {
    input.forEach((result, index) => {
      if (
        result.status !== "inserted" &&
        result.status !== "updated" &&
        result.status !== "metadata-updated" &&
        result.status !== "unchanged"
      ) {
        return collectorCoreFailure("LOCAL_APPLY_FAILED");
      }
      const expectedRow = expected[index];
      if (expectedRow === undefined) {
        return collectorCoreFailure("LOCAL_APPLY_FAILED");
      }
      const bucket = storedRowToBucket(result.row);
      if (
        !sameBucketProjection(bucket, expectedRow) ||
        result.row.localCoverage !== expectedRow.localCoverage ||
        !sameCollectorIdentity(result.row.collector, expectedRow.collector)
      ) {
        return collectorCoreFailure("LOCAL_APPLY_FAILED");
      }
    });
  } catch (error: unknown) {
    if (error instanceof CollectorCoreError) throw error;
    return collectorCoreFailure("LOCAL_APPLY_FAILED");
  }
  return input;
}

export class LocalScanCoordinator {
  readonly #collector!: DailyCollectorPort;
  readonly #store!: LocalCollectorStorePort;
  readonly #contribution!: LocalScanCoordinatorDependencies["contribution"];
  readonly #clock!: () => Date;
  readonly #uuid!: () => string;
  readonly #identity!: CollectorIdentityV1;
  #scanInProgress = false;
  #lastScan: CoordinatorLastScanDiagnostic = Object.freeze({ status: "never" });

  constructor(dependencies: LocalScanCoordinatorDependencies) {
    let collector: DailyCollectorPort;
    let store: LocalCollectorStorePort;
    let contribution: LocalScanCoordinatorDependencies["contribution"];
    let clock: () => Date;
    let uuid: () => string;
    try {
      collector = dependencies.collector;
      store = dependencies.store;
      contribution = dependencies.contribution;
      clock = dependencies.clock;
      uuid = dependencies.uuid;
    } catch {
      return collectorCoreFailure("DEPENDENCY_INVALID");
    }
    if (
      typeof collector?.scanDaily !== "function" ||
      typeof store?.getCollectorAuthority !== "function" ||
      typeof store?.upsertDailyAggregates !== "function" ||
      typeof contribution?.readContributionState !== "function" ||
      typeof clock !== "function" ||
      typeof uuid !== "function"
    ) {
      return collectorCoreFailure("DEPENDENCY_INVALID");
    }
    try {
      this.#identity = parseExactCollectorIdentity(
        collector.identity,
        TOKSCALE_COLLECTOR_IDENTITY
      );
    } catch (error: unknown) {
      if (error instanceof CollectorCoreError) throw error;
      return collectorCoreFailure("DEPENDENCY_INVALID");
    }
    this.#collector = collector;
    this.#store = store;
    this.#contribution = contribution;
    this.#clock = clock;
    this.#uuid = uuid;
  }

  #readClock(): Date {
    try {
      const now = this.#clock();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
        return collectorCoreFailure("CLOCK_INVALID");
      }
      return new Date(now.getTime());
    } catch (error: unknown) {
      if (error instanceof CollectorCoreError) throw error;
      return collectorCoreFailure("CLOCK_INVALID");
    }
  }

  #assertExactRunningAuthority(): void {
    let authority;
    try {
      authority = this.#store.getCollectorAuthority();
    } catch {
      return collectorCoreFailure("LOCAL_APPLY_FAILED");
    }
    if (authority === null) {
      return collectorCoreFailure("AUTHORITY_NOT_RUNNING");
    }
    try {
      const parsed = CollectorIdentityV1Schema.safeParse({
        kind: authority.kind,
        adapterVersion: authority.adapterVersion,
        sourceVersion: authority.sourceVersion
      });
      if (!parsed.success || !sameCollectorIdentity(parsed.data, this.#identity)) {
        return collectorCoreFailure("AUTHORITY_MISMATCH");
      }
      if (authority.state !== "running") {
        return collectorCoreFailure("AUTHORITY_NOT_RUNNING");
      }
    } catch (error: unknown) {
      if (error instanceof CollectorCoreError) throw error;
      return collectorCoreFailure("AUTHORITY_MISMATCH");
    }
  }

  async #collect(
    request: ExplicitDailyScanRequest,
    generatedAt: string
  ): Promise<readonly DailyAggregateBucketV1[]> {
    let rawOutcome: unknown;
    try {
      rawOutcome = await this.#collector.scanDaily({
        client: request.client,
        utcDate: request.utcDate,
        generatedAt,
        projectionBatchId: COLLECTOR_PROJECTION_BATCH_ID,
        projectionRevision: 1
      });
    } catch {
      return collectorCoreFailure("COLLECTOR_FAILED");
    }
    const outcome = parseCollectorScanOutcome(rawOutcome);
    if (outcome.status === "incomplete") {
      return collectorCoreFailure("COLLECTOR_INCOMPLETE");
    }
    if (outcome.snapshot === null) return Object.freeze([]);

    let snapshot: IngestSnapshotV1;
    try {
      snapshot = parseStrictIngestSnapshot(outcome.snapshot);
    } catch {
      return collectorCoreFailure("COLLECTOR_OUTPUT_INVALID");
    }
    const expectedBucketStart = request.utcDate + "T00:00:00.000Z";
    const expectedTool = toolScopeForTier1Client(request.client);
    if (
      snapshot.batchId !== COLLECTOR_PROJECTION_BATCH_ID ||
      snapshot.generatedAt !== generatedAt ||
      !sameCollectorIdentity(snapshot.collector, this.#identity) ||
      snapshot.buckets.some(
        (bucket) =>
          bucket.bucketStart !== expectedBucketStart ||
          bucket.tool !== expectedTool ||
          bucket.revision !== 1
      )
    ) {
      return collectorCoreFailure("COLLECTOR_OUTPUT_INVALID");
    }
    return Object.freeze(snapshot.buckets);
  }

  #prepareLocalScan(
    request: ExplicitDailyScanRequest,
    presentBuckets: readonly DailyAggregateBucketV1[]
  ): PreparedLocalScan {
    const bucketStart = request.utcDate + "T00:00:00.000Z";
    const tool = toolScopeForTier1Client(request.client);
    let existing: readonly StoredDailyAggregate[];
    try {
      existing = validateStoredRows(
        this.#store.listDailyAggregates({
          fromInclusive: bucketStart,
          toExclusive: nextUtcBucket(bucketStart),
          limit: MAX_LOCAL_SCAN_ROWS
        }),
        bucketStart
      );
    } catch (error: unknown) {
      if (error instanceof CollectorCoreError) throw error;
      return collectorCoreFailure("LOCAL_APPLY_FAILED");
    }

    const rows = presentBuckets.map((bucket) =>
      asProjection(bucket, this.#identity)
    );
    const presentKeys = new Set(presentBuckets.map(bucketKey));
    let inferredZeroRows = 0;
    for (const stored of existing) {
      const bucket = storedRowToBucket(stored);
      if (bucket.tool !== tool) continue;
      if (!sameCollectorIdentity(stored.collector, this.#identity)) {
        return collectorCoreFailure("AUTHORITY_MISMATCH");
      }
      if (presentKeys.has(bucketKey(bucket))) continue;
      if (
        bucket.tokens.total === "0" &&
        bucket.valueQuality === "exact" &&
        stored.localCoverage === "complete"
      ) {
        continue;
      }
      rows.push(
        Object.freeze({
          bucketStart: bucket.bucketStart,
          provider: bucket.provider,
          modelFamily: bucket.modelFamily,
          tool: bucket.tool,
          valueQuality: "exact" as const,
          tokens: ZERO_TOKENS,
          localCoverage: "complete" as const,
          collector: this.#identity
        })
      );
      inferredZeroRows += 1;
    }
    if (rows.length > MAX_LOCAL_SCAN_ROWS) {
      return collectorCoreFailure("LOCAL_SCOPE_TOO_LARGE");
    }
    for (const row of rows) projectedRowToBucket(row, 1);
    return Object.freeze({
      rows: Object.freeze(rows),
      presentBuckets,
      inferredZeroRows
    });
  }

  #applyLocalRows(
    prepared: PreparedLocalScan
  ): readonly DailyUpsertResult[] {
    this.#assertExactRunningAuthority();
    try {
      return validateApplyResults(
        this.#store.upsertDailyAggregates(prepared.rows),
        prepared.rows
      );
    } catch (error: unknown) {
      if (error instanceof CollectorCoreError) throw error;
      return collectorCoreFailure("LOCAL_APPLY_FAILED");
    }
  }

  #parseMirrorRows(
    input: readonly StoredCloudMirrorRow[],
    bucketStart: string
  ): readonly StoredCloudMirrorRow[] | CloudQueueResult {
    if (!Array.isArray(input) || input.length >= MAX_LOCAL_SCAN_ROWS) {
      return cloudBlocked("mirror-scope-too-large");
    }
    try {
      for (const row of input) {
        const bucket = DailyAggregateBucketV1Schema.parse(row.bucket);
        const collector = CollectorIdentityV1Schema.parse(row.collector);
        if (
          bucket.bucketStart !== bucketStart ||
          !sameCollectorIdentity(collector, this.#identity)
        ) {
          return cloudBlocked("mirror-correction-invalid");
        }
      }
    } catch {
      return cloudBlocked("mirror-correction-invalid");
    }
    return input;
  }

  async #queueCloud(
    request: ExplicitDailyScanRequest,
    generatedAt: string,
    prepared: PreparedLocalScan,
    applied: readonly DailyUpsertResult[]
  ): Promise<CloudQueueResult> {
    let rawContribution: unknown;
    try {
      rawContribution = await this.#contribution.readContributionState();
    } catch {
      return cloudBlocked("contribution-state-unavailable");
    }
    const contribution = parseContributionState(rawContribution);
    if (contribution === null) {
      return cloudBlocked("contribution-state-invalid");
    }
    if (contribution.status === "disabled") {
      return Object.freeze({
        status: "skipped",
        reason: "contribution-disabled"
      });
    }
    if (contribution.status === "paused") {
      return Object.freeze({
        status: "skipped",
        reason: "contribution-paused"
      });
    }
    if (
      contribution.consentDocumentRevision !==
      contribution.currentDocumentRevision
    ) {
      return Object.freeze({
        status: "skipped",
        reason: "consent-not-current"
      });
    }

    const bucketStart = request.utcDate + "T00:00:00.000Z";
    const tool = toolScopeForTier1Client(request.client);
    let mirrorRowsInput: readonly StoredCloudMirrorRow[];
    try {
      mirrorRowsInput = this.#store.listCloudMirror({
        fromInclusive: bucketStart,
        toExclusive: nextUtcBucket(bucketStart),
        limit: MAX_LOCAL_SCAN_ROWS
      });
    } catch {
      return cloudBlocked("mirror-unavailable");
    }
    const parsedMirror = this.#parseMirrorRows(mirrorRowsInput, bucketStart);
    if (!Array.isArray(parsedMirror)) {
      return parsedMirror as CloudQueueResult;
    }
    const mirrorRows = parsedMirror as readonly StoredCloudMirrorRow[];

    const presentByKey = new Map(
      prepared.presentBuckets.map((bucket) => [
        presenceKey(bucket),
        Object.freeze({
          provider: bucket.provider,
          modelFamily: bucket.modelFamily,
          tool: bucket.tool
        })
      ])
    );
    for (const row of mirrorRows) {
      if (row.bucket.tool !== tool) {
        presentByKey.set(
          presenceKey(row.bucket),
          Object.freeze({
            provider: row.bucket.provider,
            modelFamily: row.bucket.modelFamily,
            tool: row.bucket.tool
          })
        );
      }
    }
    if (presentByKey.size > MAX_LOCAL_SCAN_ROWS) {
      return cloudBlocked("mirror-scope-too-large");
    }

    let correctionPlan;
    try {
      correctionPlan = this.#store.planMissingCloudZeroCorrections({
        bucketStart,
        completeScan: true,
        collector: this.#identity,
        presentKeys: Object.freeze([...presentByKey.values()]),
        limit: MAX_INGEST_BUCKETS_V1
      });
    } catch {
      return cloudBlocked("mirror-unavailable");
    }
    try {
      if (correctionPlan.truncated === true) {
        return cloudBlocked("mirror-correction-truncated");
      }
      if (
        correctionPlan.truncated !== false ||
        !Array.isArray(correctionPlan.corrections)
      ) {
        return cloudBlocked("mirror-correction-invalid");
      }
    } catch {
      return cloudBlocked("mirror-correction-invalid");
    }

    const candidates = new Map<string, DailyAggregateBucketV1>();
    try {
      const mirrorByKey = new Map(
        mirrorRows.map((row) => [bucketKey(row.bucket), row] as const)
      );
      for (const result of applied) {
        const localBucket = storedRowToBucket(result.row);
        const mirror = mirrorByKey.get(bucketKey(localBucket));
        if (mirror === undefined) {
          // The complete local row is the initial cloud baseline. Its local
          // positive revision also safely orders against any earlier pending
          // snapshot that has not reached cloud_mirror yet.
          candidates.set(bucketKey(localBucket), localBucket);
          continue;
        }
        if (sameWireValue(localBucket, mirror.bucket)) continue;
        if (mirror.bucket.revision >= Number.MAX_SAFE_INTEGER) {
          return cloudBlocked("mirror-correction-invalid");
        }
        const revision = Math.max(
          localBucket.revision,
          mirror.bucket.revision + 1
        );
        candidates.set(
          bucketKey(localBucket),
          DailyAggregateBucketV1Schema.parse({
            ...localBucket,
            revision
          })
        );
      }
      const observedKeys = new Set(prepared.presentBuckets.map(bucketKey));
      for (const correction of correctionPlan.corrections) {
        const bucket = DailyAggregateBucketV1Schema.parse(correction.bucket);
        const collector = CollectorIdentityV1Schema.parse(correction.collector);
        const mirror = mirrorByKey.get(bucketKey(bucket));
        if (
          bucket.bucketStart !== bucketStart ||
          bucket.tool !== tool ||
          observedKeys.has(bucketKey(bucket)) ||
          mirror === undefined ||
          bucket.revision <= mirror.bucket.revision ||
          !sameCollectorIdentity(collector, this.#identity) ||
          Object.values(bucket.tokens).some((value) => value !== "0")
        ) {
          return cloudBlocked("mirror-correction-invalid");
        }
        const current = candidates.get(bucketKey(bucket));
        if (current === undefined) {
          candidates.set(bucketKey(bucket), bucket);
        } else if (current.tokens.total !== "0") {
          return cloudBlocked("mirror-correction-invalid");
        } else if (current.revision < bucket.revision) {
          candidates.set(
            bucketKey(bucket),
            DailyAggregateBucketV1Schema.parse({
              ...current,
              revision: bucket.revision
            })
          );
        }
      }
    } catch {
      return cloudBlocked("mirror-correction-invalid");
    }

    const buckets = [...candidates.values()].sort((left, right) =>
      bucketKey(left).localeCompare(bucketKey(right))
    );
    if (buckets.length === 0) {
      return Object.freeze({ status: "skipped", reason: "no-wire-changes" });
    }
    if (buckets.length > MAX_INGEST_BUCKETS_V1) {
      return cloudBlocked("too-many-wire-buckets");
    }

    let batchId: string | null;
    try {
      batchId = parseUuid(this.#uuid());
    } catch {
      batchId = null;
    }
    if (batchId === null) return cloudBlocked("identifier-unavailable");

    let snapshot: IngestSnapshotV1;
    let payloadBytes: number;
    try {
      snapshot = parseStrictIngestSnapshot({
        schemaVersion: "1",
        batchId,
        generatedAt,
        collector: this.#identity,
        buckets
      });
      payloadBytes = new TextEncoder().encode(
        canonicalSerializeIngestBatch(snapshot)
      ).byteLength;
    } catch {
      return cloudBlocked("snapshot-invalid");
    }
    if (payloadBytes > MAX_INGEST_BODY_BYTES) {
      return cloudBlocked("payload-too-large");
    }

    const expiresAt = new Date(
      Date.parse(generatedAt) + THIRTY_DAYS_MS
    ).toISOString();
    try {
      this.#store.enqueueCloudSnapshot(snapshot, {
        nextAttemptAt: generatedAt,
        expiresAt
      });
    } catch {
      return cloudBlocked("outbox-unavailable");
    }
    return Object.freeze({
      status: "queued",
      batchId,
      generatedAt,
      bucketCount: buckets.length,
      payloadBytes
    });
  }

  async scanDaily(input: unknown): Promise<LocalDailyScanResult> {
    if (this.#scanInProgress) {
      return collectorCoreFailure("SCAN_IN_PROGRESS");
    }
    this.#scanInProgress = true;
    try {
      const now = this.#readClock();
      const request = parseExplicitDailyScanRequest(input, now);
      const generatedAt = now.toISOString();
      this.#assertExactRunningAuthority();
      const presentBuckets = await this.#collect(request, generatedAt);
      this.#assertExactRunningAuthority();
      const prepared = this.#prepareLocalScan(request, presentBuckets);
      const applied = this.#applyLocalRows(prepared);
      const cloudQueue = await this.#queueCloud(
        request,
        generatedAt,
        prepared,
        applied
      );
      const counts = countsFromResults(applied);
      const result: LocalDailyScanResult = Object.freeze({
        status: "applied",
        client: request.client,
        tool: toolScopeForTier1Client(request.client),
        bucketStart: request.utcDate + "T00:00:00.000Z",
        complete: true,
        observedRows: presentBuckets.length,
        appliedRows: applied.length,
        ...counts,
        inferredZeroRows: prepared.inferredZeroRows,
        cloudQueue
      });
      this.#lastScan = Object.freeze({
        status: "applied",
        observedRows: result.observedRows,
        appliedRows: result.appliedRows,
        inferredZeroRows: result.inferredZeroRows,
        cloudQueueStatus: cloudQueue.status,
        cloudQueueReason:
          cloudQueue.status === "queued" ? null : cloudQueue.reason
      });
      return result;
    } catch (error: unknown) {
      const sanitized = sanitizeUnexpected(error);
      this.#lastScan = Object.freeze({
        status: "failed",
        code: sanitized.code
      });
      throw sanitized;
    } finally {
      this.#scanInProgress = false;
    }
  }

  listDueUploads(input: unknown): readonly QueuedCloudSnapshot[] {
    const query: DueUploadQuery = parseDueUploadQuery(input);
    let queued: readonly QueuedCloudSnapshot[];
    try {
      queued = this.#store.listDueCloudSnapshots(query);
    } catch {
      return collectorCoreFailure("OUTBOX_READ_FAILED");
    }
    try {
      if (!Array.isArray(queued) || queued.length > query.limit) {
        return collectorCoreFailure("OUTBOX_READ_FAILED");
      }
      return Object.freeze(
        queued.map((entry) => {
          const snapshot = parseStrictIngestSnapshot(entry.snapshot);
          if (!sameCollectorIdentity(snapshot.collector, this.#identity)) {
            return collectorCoreFailure("OUTBOX_READ_FAILED");
          }
          const bytes = new TextEncoder().encode(
            canonicalSerializeIngestBatch(snapshot)
          ).byteLength;
          if (bytes > MAX_INGEST_BODY_BYTES) {
            return collectorCoreFailure("OUTBOX_READ_FAILED");
          }
          return Object.freeze({ ...entry, snapshot });
        })
      );
    } catch (error: unknown) {
      if (error instanceof CollectorCoreError) throw error;
      return collectorCoreFailure("OUTBOX_READ_FAILED");
    }
  }

  recordUploadRetry(input: unknown): boolean {
    const retry: UploadRetryInput = parseUploadRetryInput(input);
    try {
      return this.#store.rescheduleCloudSnapshot(retry);
    } catch {
      return collectorCoreFailure("OUTBOX_RETRY_FAILED");
    }
  }

  getDiagnosticSummary(): CollectorCoreDiagnosticSummary {
    let localStore: CollectorCoreDiagnosticSummary["localStore"];
    try {
      const diagnostic = this.#store.getDiagnosticSummary();
      const counts = diagnostic.counts;
      const values = [
        counts.dailyAggregates,
        counts.cloudMirrorEntries,
        counts.cloudOutboxEntries
      ];
      if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
        throw new Error("invalid bounded count");
      }
      const authority = diagnostic.collectorAuthority;
      localStore = Object.freeze({
        status: "available",
        dailyAggregateCount: counts.dailyAggregates,
        cloudMirrorCount: counts.cloudMirrorEntries,
        cloudOutboxCount: counts.cloudOutboxEntries,
        authorityConfigured: authority.configured,
        authorityRunning:
          authority.configured &&
          authority.state === "running" &&
          authority.kind === this.#identity.kind &&
          authority.adapterVersion === this.#identity.adapterVersion &&
          authority.sourceVersion === this.#identity.sourceVersion
      });
    } catch {
      localStore = Object.freeze({ status: "unavailable" });
    }
    return Object.freeze({
      schemaVersion: "1",
      scanInProgress: this.#scanInProgress,
      collector: this.#identity,
      lastScan: this.#lastScan,
      localStore
    });
  }
}

export function createLocalScanCoordinator(
  dependencies: LocalScanCoordinatorDependencies
): LocalScanCoordinator {
  try {
    return new LocalScanCoordinator(dependencies);
  } catch (error: unknown) {
    if (error instanceof CollectorCoreError) throw error;
    return collectorCoreFailure("DEPENDENCY_INVALID");
  }
}
