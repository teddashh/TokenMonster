import {
  parseIngestSnapshotV1,
  type CollectorIdentityV1,
  type DailyAggregateBucketV1,
  type IngestSnapshotV1,
  type TokenCountsV1
} from "@tokenmonster/contracts";
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
import { describe, expect, it } from "vitest";

import {
  CollectorCoreError,
  TOKSCALE_COLLECTOR_IDENTITY,
  createLocalScanCoordinator,
  type ContributionState,
  type DailyCollectorPort,
  type DailyCollectorScanRequest,
  type LocalCollectorStorePort
} from "../src/index.js";

const NOW = "2026-07-15T18:00:00.000Z";
const BUCKET_START = "2026-07-15T00:00:00.000Z";

const TOKENS: TokenCountsV1 = Object.freeze({
  input: "120",
  output: "50",
  cacheRead: "30",
  cacheWrite: "0",
  reasoning: "10",
  other: "0",
  total: "200"
});

const ZERO_TOKENS: TokenCountsV1 = Object.freeze({
  input: "0",
  output: "0",
  cacheRead: "0",
  cacheWrite: "0",
  reasoning: "0",
  other: "0",
  total: "0"
});

function keyOf(
  value: Pick<
    DailyAggregateBucketV1,
    "bucketStart" | "provider" | "modelFamily" | "tool"
  >
): string {
  return [value.bucketStart, value.provider, value.modelFamily, value.tool].join(
    "|"
  );
}

function sameTokens(left: TokenCountsV1, right: TokenCountsV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function bucket(
  overrides: Partial<DailyAggregateBucketV1> = {}
): DailyAggregateBucketV1 {
  return {
    bucketStart: BUCKET_START,
    provider: "openai",
    modelFamily: "gpt-5",
    tool: "codex-cli",
    valueQuality: "exact",
    revision: 1,
    tokens: TOKENS,
    ...overrides
  };
}

class FakeCollector implements DailyCollectorPort {
  readonly identity = TOKSCALE_COLLECTOR_IDENTITY;
  readonly outcomes: Array<
    | unknown
    | ((request: DailyCollectorScanRequest) => unknown)
  > = [];

  async scanDaily(request: DailyCollectorScanRequest): Promise<unknown> {
    const next = this.outcomes.shift();
    if (typeof next === "function") return next(request);
    if (next === undefined) throw new Error("fixture missing");
    return next;
  }

  complete(buckets: readonly DailyAggregateBucketV1[]): void {
    this.outcomes.push((request: DailyCollectorScanRequest) => ({
      status: "complete",
      snapshot:
        buckets.length === 0
          ? null
          : {
              schemaVersion: "1",
              batchId: request.projectionBatchId,
              generatedAt: request.generatedAt,
              collector: this.identity,
              buckets: buckets.map((entry) => ({ ...entry, revision: 1 }))
            }
    }));
  }
}

class FakeStore implements LocalCollectorStorePort {
  authority: StoredCollectorAuthority | null = {
    ...TOKSCALE_COLLECTOR_IDENTITY,
    state: "running",
    updatedAt: NOW
  };
  readonly daily = new Map<string, StoredDailyAggregate>();
  readonly mirror = new Map<string, StoredCloudMirrorRow>();
  readonly outbox = new Map<string, QueuedCloudSnapshot>();
  forceCorrectionTruncated = false;
  mirrorReads = 0;

  getCollectorAuthority(): StoredCollectorAuthority | null {
    return this.authority;
  }

  listDailyAggregates(input: DailyAggregateQuery): readonly StoredDailyAggregate[] {
    return [...this.daily.values()]
      .filter(
        (row) =>
          (input.fromInclusive === undefined ||
            row.bucketStart >= input.fromInclusive) &&
          (input.toExclusive === undefined || row.bucketStart < input.toExclusive)
      )
      .sort((left, right) => keyOf(left).localeCompare(keyOf(right)))
      .slice(0, input.limit);
  }

  upsertDailyAggregates(input: readonly unknown[]): readonly DailyUpsertResult[] {
    const rows = input as readonly ProjectedDailyAggregate[];
    const keys = rows.map(keyOf);
    if (new Set(keys).size !== keys.length) throw new Error("duplicate fixture");
    return rows.map((row) => {
      const key = keyOf(row);
      const existing = this.daily.get(key);
      if (existing === undefined) {
        const stored = Object.freeze({ ...row, revision: 1, updatedAt: NOW });
        this.daily.set(key, stored);
        return Object.freeze({ status: "inserted" as const, row: stored });
      }
      const projectionChanged =
        existing.valueQuality !== row.valueQuality ||
        !sameTokens(existing.tokens, row.tokens);
      const metadataChanged =
        existing.localCoverage !== row.localCoverage ||
        JSON.stringify(existing.collector) !== JSON.stringify(row.collector);
      if (!projectionChanged && !metadataChanged) {
        return Object.freeze({ status: "unchanged" as const, row: existing });
      }
      const revision = projectionChanged
        ? existing.revision + 1
        : existing.revision;
      const stored = Object.freeze({ ...row, revision, updatedAt: NOW });
      this.daily.set(key, stored);
      return Object.freeze({
        status: projectionChanged
          ? ("updated" as const)
          : ("metadata-updated" as const),
        row: stored
      });
    });
  }

  listCloudMirror(input: CloudMirrorQuery): readonly StoredCloudMirrorRow[] {
    this.mirrorReads += 1;
    return [...this.mirror.values()]
      .filter(
        (row) =>
          (input.fromInclusive === undefined ||
            row.bucket.bucketStart >= input.fromInclusive) &&
          (input.toExclusive === undefined ||
            row.bucket.bucketStart < input.toExclusive)
      )
      .sort((left, right) =>
        keyOf(left.bucket).localeCompare(keyOf(right.bucket))
      )
      .slice(0, input.limit);
  }

  planMissingCloudZeroCorrections(
    input: MissingCloudZeroCorrectionQuery
  ): MissingCloudZeroCorrectionPlan {
    const present = new Set(
      input.presentKeys.map((entry) =>
        [entry.provider, entry.modelFamily, entry.tool].join("|")
      )
    );
    const missing = [...this.mirror.values()].filter(
      (row) =>
        row.bucket.bucketStart === input.bucketStart &&
        !present.has(
          [
            row.bucket.provider,
            row.bucket.modelFamily,
            row.bucket.tool
          ].join("|")
        ) &&
        row.bucket.tokens.total !== "0"
    );
    const corrections = missing.slice(0, input.limit).map((row) => ({
      collector: input.collector,
      bucket: {
        ...row.bucket,
        revision: row.bucket.revision + 1,
        tokens: ZERO_TOKENS
      }
    }));
    return {
      corrections,
      truncated:
        this.forceCorrectionTruncated || missing.length > corrections.length
    };
  }

  enqueueCloudSnapshot(
    snapshotInput: unknown,
    options: EnqueueCloudSnapshotOptions
  ): "inserted" | "idempotent" {
    const snapshot = parseIngestSnapshotV1(snapshotInput);
    const existing = this.outbox.get(snapshot.batchId);
    if (existing !== undefined) {
      if (JSON.stringify(existing.snapshot) !== JSON.stringify(snapshot)) {
        throw new Error("batch conflict");
      }
      return "idempotent";
    }
    this.outbox.set(
      snapshot.batchId,
      Object.freeze({
        snapshot,
        attempts: 0,
        nextAttemptAt: options.nextAttemptAt,
        expiresAt: options.expiresAt,
        lastErrorCode: null
      })
    );
    return "inserted";
  }

  listDueCloudSnapshots(
    input: DueCloudSnapshotQuery
  ): readonly QueuedCloudSnapshot[] {
    return [...this.outbox.values()]
      .filter(
        (entry) =>
          entry.nextAttemptAt <= input.now && entry.expiresAt > input.now
      )
      .slice(0, input.limit);
  }

  rescheduleCloudSnapshot(input: RescheduleCloudSnapshotInput): boolean {
    const existing = this.outbox.get(input.batchId);
    if (existing === undefined) return false;
    this.outbox.set(
      input.batchId,
      Object.freeze({
        ...existing,
        attempts: existing.attempts + 1,
        nextAttemptAt: input.nextAttemptAt,
        lastErrorCode: input.errorCode
      })
    );
    return true;
  }

  getDiagnosticSummary(): LocalStoreDiagnosticSummary {
    return {
      schemaVersion: 4,
      storage: "memory",
      journalMode: "memory",
      securityPragmas: {
        foreignKeys: true,
        busyTimeoutMs: 5_000,
        secureDelete: true
      },
      counts: {
        dailyAggregates: this.daily.size,
        completeScanScopes: 0,
        cloudMirrorEntries: this.mirror.size,
        monsterSnapshots: 0,
        cloudOutboxEntries: this.outbox.size
      },
      configConfigured: false,
      collectorAuthority:
        this.authority === null
          ? { configured: false }
          : {
              configured: true,
              kind: this.authority.kind,
              state: this.authority.state,
              adapterVersion: this.authority.adapterVersion,
              sourceVersion: this.authority.sourceVersion
            }
    };
  }

  accept(snapshot: IngestSnapshotV1): void {
    for (const accepted of snapshot.buckets) {
      this.mirror.set(
        keyOf(accepted),
        Object.freeze({
          bucket: accepted,
          collector: snapshot.collector,
          receipt: { batchId: snapshot.batchId, receivedAt: NOW },
          updatedAt: NOW
        })
      );
    }
  }
}

function createFixture(
  contributionState: ContributionState = {
    status: "active",
    consentDocumentRevision: "contribution-2026-07-15",
    currentDocumentRevision: "contribution-2026-07-15"
  }
): {
  readonly collector: FakeCollector;
  readonly store: FakeStore;
  readonly coordinator: ReturnType<typeof createLocalScanCoordinator>;
  readonly setContributionState: (state: ContributionState) => void;
} {
  const collector = new FakeCollector();
  const store = new FakeStore();
  let currentContributionState = contributionState;
  let uuidSequence = 1;
  const coordinator = createLocalScanCoordinator({
    collector,
    store,
    contribution: {
      readContributionState: () => currentContributionState
    },
    clock: () => new Date(NOW),
    uuid: () =>
      "550e8400-e29b-41d4-a716-" +
      "446655440" +
      String(uuidSequence++).padStart(3, "0")
  });
  return {
    collector,
    store,
    coordinator,
    setContributionState: (state: ContributionState) => {
      currentContributionState = state;
    }
  };
}

async function scan(
  coordinator: ReturnType<typeof createLocalScanCoordinator>
) {
  return coordinator.scanDaily({ client: "codex", utcDate: "2026-07-15" });
}

describe("explicit absolute local scans", () => {
  it("applies initial, downward, and explicit-zero rows with per-key revisions", async () => {
    const { collector, store, coordinator } = createFixture();
    collector.complete([bucket()]);
    expect(await scan(coordinator)).toMatchObject({
      insertedRows: 1,
      cloudQueue: { status: "queued", bucketCount: 1 }
    });
    const initial = [...store.outbox.values()][0]?.snapshot;
    if (initial === undefined) throw new Error("missing initial snapshot");
    store.accept(initial);

    collector.complete([bucket()]);
    expect(await scan(coordinator)).toMatchObject({
      unchangedRows: 1,
      cloudQueue: { status: "skipped", reason: "no-wire-changes" }
    });

    collector.complete([
      bucket({
        tokens: {
          input: "20",
          output: "10",
          cacheRead: "0",
          cacheWrite: "0",
          reasoning: "2",
          other: "0",
          total: "30"
        }
      })
    ]);
    expect(await scan(coordinator)).toMatchObject({
      updatedRows: 1,
      cloudQueue: { status: "queued" }
    });
    expect(store.daily.get(keyOf(bucket()))?.revision).toBe(2);

    collector.complete([bucket({ tokens: ZERO_TOKENS })]);
    expect(await scan(coordinator)).toMatchObject({
      updatedRows: 1,
      cloudQueue: { status: "queued" }
    });
    expect(store.daily.get(keyOf(bucket()))).toMatchObject({
      revision: 3,
      tokens: { total: "0" }
    });
  });

  it("turns a missing key into local and cloud higher-revision zero only after a complete scan", async () => {
    const { collector, store, coordinator } = createFixture();
    collector.complete([bucket()]);
    await scan(coordinator);
    const initial = [...store.outbox.values()][0]?.snapshot;
    if (initial === undefined) throw new Error("missing initial snapshot");
    store.accept(initial);

    collector.complete([]);
    const result = await scan(coordinator);
    expect(result).toMatchObject({
      observedRows: 0,
      inferredZeroRows: 1,
      updatedRows: 1,
      cloudQueue: { status: "queued", bucketCount: 1 }
    });
    const correction = [...store.outbox.values()].at(-1)?.snapshot.buckets[0];
    expect(correction).toMatchObject({ revision: 2, tokens: ZERO_TOKENS });
    expect(store.daily.get(keyOf(bucket()))).toMatchObject({
      revision: 2,
      tokens: ZERO_TOKENS
    });
  });

  it("does not mutate local or cloud state for an incomplete scan", async () => {
    const { collector, store, coordinator } = createFixture();
    collector.outcomes.push({ status: "incomplete" });
    await expect(scan(coordinator)).rejects.toMatchObject({
      code: "COLLECTOR_INCOMPLETE"
    });
    expect(store.daily.size).toBe(0);
    expect(store.outbox.size).toBe(0);
  });

  it("validates every collector row before the atomic local apply", async () => {
    const { collector, store, coordinator } = createFixture();
    collector.outcomes.push((request: DailyCollectorScanRequest) => ({
      status: "complete",
      snapshot: {
        schemaVersion: "1",
        batchId: request.projectionBatchId,
        generatedAt: request.generatedAt,
        collector: TOKSCALE_COLLECTOR_IDENTITY,
        buckets: [
          bucket(),
          bucket({
            modelFamily: "broken-model",
            tokens: { ...TOKENS, total: "201" }
          })
        ]
      }
    }));
    await expect(scan(coordinator)).rejects.toMatchObject({
      code: "COLLECTOR_OUTPUT_INVALID"
    });
    expect(store.daily.size).toBe(0);
    expect(store.outbox.size).toBe(0);
  });

  it("keeps the scan purely local when contribution is disabled", async () => {
    const { collector, store, coordinator } = createFixture({
      status: "disabled"
    });
    collector.complete([bucket()]);
    expect(await scan(coordinator)).toMatchObject({
      insertedRows: 1,
      cloudQueue: {
        status: "skipped",
        reason: "contribution-disabled"
      }
    });
    expect(store.daily.size).toBe(1);
    expect(store.outbox.size).toBe(0);
    expect(store.mirrorReads).toBe(0);
  });

  it("queues the complete current baseline when contribution activates after a local-only scan", async () => {
    const { collector, store, coordinator, setContributionState } =
      createFixture({ status: "disabled" });
    collector.complete([bucket()]);
    await scan(coordinator);
    expect(store.daily.get(keyOf(bucket()))?.revision).toBe(1);
    expect(store.outbox.size).toBe(0);

    setContributionState({
      status: "active",
      consentDocumentRevision: "contribution-2026-07-15",
      currentDocumentRevision: "contribution-2026-07-15"
    });
    collector.complete([bucket()]);
    const activated = await scan(coordinator);
    expect(activated).toMatchObject({
      unchangedRows: 1,
      cloudQueue: { status: "queued", bucketCount: 1 }
    });
    expect([...store.outbox.values()][0]?.snapshot.buckets[0]).toMatchObject({
      revision: 1,
      tokens: TOKENS
    });
  });

  it("derives a higher wire revision from cloud_mirror when local revision lags", async () => {
    const { collector, store, coordinator } = createFixture();
    const mirrored = bucket({
      revision: 9,
      tokens: {
        input: "1",
        output: "1",
        cacheRead: "0",
        cacheWrite: "0",
        reasoning: "0",
        other: "0",
        total: "2"
      }
    });
    store.accept({
      schemaVersion: "1",
      batchId: "550e8400-e29b-41d4-a716-446655440097",
      generatedAt: NOW,
      collector: TOKSCALE_COLLECTOR_IDENTITY,
      buckets: [mirrored]
    });
    collector.complete([bucket()]);

    expect(await scan(coordinator)).toMatchObject({
      insertedRows: 1,
      cloudQueue: { status: "queued", bucketCount: 1 }
    });
    expect([...store.outbox.values()][0]?.snapshot.buckets[0]).toMatchObject({
      revision: 10,
      tokens: TOKENS
    });
    expect(store.daily.get(keyOf(bucket()))?.revision).toBe(1);
  });

  it("does not queue when the granted contribution consent is not current", async () => {
    const { collector, store, coordinator } = createFixture({
      status: "active",
      consentDocumentRevision: "contribution-2026-06-01",
      currentDocumentRevision: "contribution-2026-07-15"
    });
    collector.complete([bucket()]);
    expect(await scan(coordinator)).toMatchObject({
      insertedRows: 1,
      cloudQueue: { status: "skipped", reason: "consent-not-current" }
    });
    expect(store.outbox.size).toBe(0);
    expect(store.mirrorReads).toBe(0);
  });

  it("keeps local commit but blocks every cloud row when correction planning is truncated", async () => {
    const { collector, store, coordinator } = createFixture();
    collector.complete([bucket()]);
    await scan(coordinator);
    const initial = [...store.outbox.values()][0]?.snapshot;
    if (initial === undefined) throw new Error("missing initial snapshot");
    store.accept(initial);
    store.forceCorrectionTruncated = true;

    collector.complete([]);
    expect(await scan(coordinator)).toMatchObject({
      inferredZeroRows: 1,
      cloudQueue: {
        status: "blocked",
        reason: "mirror-correction-truncated"
      }
    });
    expect(store.daily.get(keyOf(bucket()))?.tokens.total).toBe("0");
    expect(store.outbox.size).toBe(1);
  });

  it("does not zero another audited client tool while scanning one complete scope", async () => {
    const { collector, store, coordinator } = createFixture();
    const codexAccepted = bucket();
    const claudeAccepted = bucket({
      provider: "anthropic",
      modelFamily: "claude-sonnet",
      tool: "claude-code"
    });
    const acceptedSnapshot: IngestSnapshotV1 = {
      schemaVersion: "1",
      batchId: "550e8400-e29b-41d4-a716-446655440099",
      generatedAt: NOW,
      collector: TOKSCALE_COLLECTOR_IDENTITY,
      buckets: [codexAccepted, claudeAccepted]
    };
    store.accept(acceptedSnapshot);
    store.upsertDailyAggregates([
      {
        ...codexAccepted,
        localCoverage: "complete",
        collector: TOKSCALE_COLLECTOR_IDENTITY
      },
      {
        ...claudeAccepted,
        localCoverage: "complete",
        collector: TOKSCALE_COLLECTOR_IDENTITY
      }
    ]);

    collector.complete([]);
    await scan(coordinator);
    const queued = [...store.outbox.values()][0]?.snapshot.buckets;
    expect(queued).toHaveLength(1);
    expect(queued?.[0]?.tool).toBe("codex-cli");
    expect(store.daily.get(keyOf(claudeAccepted))?.tokens.total).toBe("200");
  });
});

describe("fixed outbox and privacy boundaries", () => {
  it("keeps batchId, generatedAt, and payload fixed when retry metadata changes", async () => {
    const { collector, coordinator } = createFixture();
    collector.complete([bucket()]);
    const result = await scan(coordinator);
    if (result.cloudQueue.status !== "queued") {
      throw new Error("expected queued fixture");
    }
    const first = coordinator.listDueUploads({ now: NOW, limit: 30 })[0];
    if (first === undefined) throw new Error("missing due fixture");
    const fixedPayload = JSON.stringify(first.snapshot);

    expect(
      coordinator.recordUploadRetry({
        batchId: first.snapshot.batchId,
        nextAttemptAt: "2026-07-15T18:01:00.000Z",
        errorCode: "network"
      })
    ).toBe(true);
    const retry = coordinator.listDueUploads({
      now: "2026-07-15T18:01:00.000Z",
      limit: 30
    })[0];
    expect(retry?.snapshot.batchId).toBe(result.cloudQueue.batchId);
    expect(retry?.snapshot.generatedAt).toBe(NOW);
    expect(JSON.stringify(retry?.snapshot)).toBe(fixedPayload);
    expect(retry?.attempts).toBe(1);
  });

  it("sanitizes raw collector failures and keeps diagnostics content-free", async () => {
    const { collector, coordinator } = createFixture();
    const keyCanary = ["sk", "collector-private-canary"].join("-");
    const canaries = [
      keyCanary,
      "/private/project/source.ts",
      "raw prompt body",
      "raw collector response"
    ];
    collector.outcomes.push(() => {
      throw new Error(canaries.join(" :: "));
    });

    let caught: unknown;
    try {
      await scan(coordinator);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CollectorCoreError);
    expect(caught).toMatchObject({ code: "COLLECTOR_FAILED" });
    const exposed =
      String(caught) +
      (caught instanceof Error ? caught.stack : "") +
      JSON.stringify(coordinator.getDiagnosticSummary());
    for (const canary of canaries) expect(exposed).not.toContain(canary);
    expect(coordinator.getDiagnosticSummary()).toMatchObject({
      schemaVersion: "1",
      lastScan: { status: "failed", code: "COLLECTOR_FAILED" },
      localStore: { status: "available" }
    });
  });

  it("rejects a non-running or mismatched authority before invoking collection", async () => {
    const { collector, store, coordinator } = createFixture();
    store.authority = {
      ...TOKSCALE_COLLECTOR_IDENTITY,
      state: "degraded",
      updatedAt: NOW
    };
    collector.complete([bucket()]);
    await expect(scan(coordinator)).rejects.toMatchObject({
      code: "AUTHORITY_NOT_RUNNING"
    });
    expect(collector.outcomes).toHaveLength(1);
    expect(store.daily.size).toBe(0);
  });

  it("never queues a partial V1 batch when changed rows plus zeros exceed 30", async () => {
    const { collector, store, coordinator } = createFixture();
    const observed = Array.from({ length: 30 }, (_, index) =>
      bucket({ modelFamily: "model-" + String(index) })
    );
    const oldMirror = bucket({ modelFamily: "old-model" });
    store.accept({
      schemaVersion: "1",
      batchId: "550e8400-e29b-41d4-a716-446655440098",
      generatedAt: NOW,
      collector: TOKSCALE_COLLECTOR_IDENTITY,
      buckets: [oldMirror]
    });
    collector.complete(observed);

    expect(await scan(coordinator)).toMatchObject({
      insertedRows: 30,
      cloudQueue: {
        status: "blocked",
        reason: "too-many-wire-buckets"
      }
    });
    expect(store.daily.size).toBe(30);
    expect(store.outbox.size).toBe(0);
  });
});
