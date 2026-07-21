import type {
  DailyAggregateBucketV1,
  SupportedCollectorIdentity,
  SupportedIngestSnapshot
} from "@tokenmonster/contracts";

import type { CanonicalHasher } from "./canonical-json.js";
import { UsageDomainError } from "./errors.js";
import {
  canonicalAuthorityKey,
  canonicalBatchReceiptKey,
  canonicalUsageKey
} from "./keys.js";
import { hashIngestBatch, hashServerRow } from "./serialization.js";
import type {
  ApplyIngestPlan,
  AuthenticatedEnrollment,
  AuthorityBinding,
  BatchReceipt,
  BucketDecision,
  CanonicalUsageRow,
  ExecuteIngestResult,
  IngestBatchPlan,
  IngestDecisionSummary,
  UsageDomainState
} from "./types.js";
import {
  parseAuthenticatedEnrollment,
  parseReceivedAt,
  parseStrictIngestSnapshot
} from "./validation.js";

const IDENTIFIABLE_RETENTION_MS = 30 * 86_400_000;

export interface IngestExecutionOptions {
  readonly receivedAt: string;
  readonly hasher?: CanonicalHasher;
}

function assertInsideRetention(
  snapshot: SupportedIngestSnapshot,
  receivedAt: string
): void {
  const receivedAtMs = Date.parse(receivedAt);
  const receivedDayStart = Date.parse(receivedAt.slice(0, 10) + "T00:00:00.000Z");
  for (const [bucketIndex, bucket] of snapshot.buckets.entries()) {
    const bucketStartMs = Date.parse(bucket.bucketStart);
    if (
      bucketStartMs > receivedDayStart ||
      bucketStartMs + IDENTIFIABLE_RETENTION_MS <= receivedAtMs
    ) {
      throw new UsageDomainError(
        "BUCKET_OUTSIDE_RETENTION",
        "An ingest bucket is outside the current identifiable UTC window.",
        { bucketIndex }
      );
    }
  }
}

function freezeRow(
  enrollment: AuthenticatedEnrollment,
  collector: SupportedCollectorIdentity,
  bucket: DailyAggregateBucketV1,
  rowHash: string
): CanonicalUsageRow {
  const tokens = Object.freeze({ ...bucket.tokens });
  const frozenCollector = Object.freeze({ ...collector });
  return Object.freeze({
    key: canonicalUsageKey({
      enrollmentId: enrollment.enrollmentId,
      bucketStart: bucket.bucketStart,
      provider: bucket.provider,
      modelFamily: bucket.modelFamily,
      tool: bucket.tool
    }),
    enrollmentId: enrollment.enrollmentId,
    bucketStart: bucket.bucketStart,
    provider: bucket.provider,
    modelFamily: bucket.modelFamily,
    tool: bucket.tool,
    valueQuality: bucket.valueQuality,
    revision: bucket.revision,
    tokens,
    collector: frozenCollector,
    rowHash
  });
}

async function buildRows(
  enrollment: AuthenticatedEnrollment,
  snapshot: SupportedIngestSnapshot,
  hasher: CanonicalHasher | undefined
): Promise<CanonicalUsageRow[]> {
  const rows: CanonicalUsageRow[] = [];
  for (const bucket of snapshot.buckets) {
    const rowHash = await hashServerRow(
      enrollment,
      snapshot.collector,
      bucket,
      hasher
    );
    rows.push(freezeRow(enrollment, snapshot.collector, bucket, rowHash));
  }
  return rows;
}

function buildSummary(decisions: readonly BucketDecision[]): IngestDecisionSummary {
  return Object.freeze({
    appliedBuckets: decisions.filter(
      ({ status }) => status === "insert" || status === "replace"
    ).length,
    staleBuckets: decisions.filter(({ status }) => status === "stale").length,
    idempotentBuckets: decisions.filter(({ status }) => status === "idempotent")
      .length,
    quarantinedBuckets: 0
  });
}

function preflightAuthorities(
  enrollment: AuthenticatedEnrollment,
  snapshot: SupportedIngestSnapshot,
  state: UsageDomainState
): AuthorityBinding[] {
  const inserts = new Map<string, AuthorityBinding>();
  snapshot.buckets.forEach((bucket, bucketIndex) => {
    const key = canonicalAuthorityKey({
      enrollmentId: enrollment.enrollmentId,
      bucketStart: bucket.bucketStart
    });
    const existing = state.authorityBindings.get(key);
    if (
      existing !== undefined &&
      (existing.collectorKind !== snapshot.collector.kind ||
        existing.adapterVersion !== snapshot.collector.adapterVersion ||
        existing.sourceVersion !== snapshot.collector.sourceVersion)
    ) {
      throw new UsageDomainError(
        "AUTHORITY_CONFLICT",
        "A UTC source window is already bound to another collector authority version.",
        { bucketIndex }
      );
    }
    if (existing === undefined && !inserts.has(key)) {
      inserts.set(
        key,
        Object.freeze({
          key,
          enrollmentId: enrollment.enrollmentId,
          bucketStart: bucket.bucketStart,
          collectorKind: snapshot.collector.kind,
          adapterVersion: snapshot.collector.adapterVersion,
          sourceVersion: snapshot.collector.sourceVersion
        })
      );
    }
  });
  return [...inserts.values()];
}

function decideRows(
  incomingRows: readonly CanonicalUsageRow[],
  state: UsageDomainState
): BucketDecision[] {
  return incomingRows.map((incoming, bucketIndex) => {
    const existing = state.rows.get(incoming.key);
    if (existing === undefined) {
      return Object.freeze({ bucketIndex, key: incoming.key, status: "insert", incoming });
    }
    if (incoming.revision > existing.revision) {
      return Object.freeze({ bucketIndex, key: incoming.key, status: "replace", incoming });
    }
    if (incoming.revision < existing.revision) {
      return Object.freeze({ bucketIndex, key: incoming.key, status: "stale", incoming });
    }
    if (incoming.rowHash === existing.rowHash) {
      return Object.freeze({
        bucketIndex,
        key: incoming.key,
        status: "idempotent",
        incoming
      });
    }
    throw new UsageDomainError(
      "REVISION_CONFLICT",
      "Equal revisions have different canonical server row hashes.",
      { bucketIndex }
    );
  });
}

export async function preflightIngestBatch(
  bodyInput: unknown,
  authInput: unknown,
  state: UsageDomainState,
  options: IngestExecutionOptions
): Promise<IngestBatchPlan> {
  const snapshot = parseStrictIngestSnapshot(bodyInput);
  const enrollment = parseAuthenticatedEnrollment(authInput);
  const receivedAt = parseReceivedAt(options.receivedAt);
  assertInsideRetention(snapshot, receivedAt);

  const payloadHash = await hashIngestBatch(snapshot, options.hasher);
  const receiptKey = canonicalBatchReceiptKey({
    enrollmentId: enrollment.enrollmentId,
    batchId: snapshot.batchId
  });
  const existingReceipt = state.batchReceipts.get(receiptKey);
  if (existingReceipt !== undefined) {
    if (existingReceipt.payloadHash !== payloadHash) {
      throw new UsageDomainError(
        "BATCH_ID_REUSE",
        "A batch ID was reused with a different canonical payload hash."
      );
    }
    return Object.freeze({
      kind: "replay",
      expectedStateVersion: state.version,
      payloadHash,
      decisions: Object.freeze([]),
      receipt: existingReceipt
    });
  }

  const authorityInserts = preflightAuthorities(enrollment, snapshot, state);
  const rows = await buildRows(enrollment, snapshot, options.hasher);
  const decisions = decideRows(rows, state);
  const rowUpserts = decisions
    .filter(({ status }) => status === "insert" || status === "replace")
    .map(({ incoming }) => incoming);
  const summary = buildSummary(decisions);
  const receipt: BatchReceipt = Object.freeze({
    key: receiptKey,
    enrollmentId: enrollment.enrollmentId,
    batchId: snapshot.batchId,
    payloadHash,
    receivedAt,
    summary
  });

  return Object.freeze({
    kind: "apply",
    expectedStateVersion: state.version,
    payloadHash,
    decisions: Object.freeze(decisions),
    rowUpserts: Object.freeze(rowUpserts),
    authorityInserts: Object.freeze(authorityInserts),
    receipt
  });
}

function assertPlanFresh(state: UsageDomainState, expectedVersion: number): void {
  if (state.version !== expectedVersion) {
    throw new UsageDomainError(
      "PLAN_STALE",
      "The atomic plan was based on a stale domain state version."
    );
  }
}

export function applyIngestBatchPlan(
  state: UsageDomainState,
  plan: IngestBatchPlan
): ExecuteIngestResult {
  assertPlanFresh(state, plan.expectedStateVersion);
  if (plan.kind === "replay") {
    return Object.freeze({
      state,
      receipt: plan.receipt,
      decisions: plan.decisions,
      replayed: true
    });
  }

  const rows = new Map(state.rows);
  const authorityBindings = new Map(state.authorityBindings);
  const batchReceipts = new Map(state.batchReceipts);
  for (const row of plan.rowUpserts) rows.set(row.key, row);
  for (const binding of plan.authorityInserts) {
    authorityBindings.set(binding.key, binding);
  }
  batchReceipts.set(plan.receipt.key, plan.receipt);

  const nextState: UsageDomainState = Object.freeze({
    version: state.version + 1,
    rows,
    authorityBindings,
    batchReceipts,
    anonymousRollups: state.anonymousRollups
  });
  return Object.freeze({
    state: nextState,
    receipt: plan.receipt,
    decisions: plan.decisions,
    replayed: false
  });
}

export async function executeIngestBatch(
  bodyInput: unknown,
  authInput: unknown,
  state: UsageDomainState,
  options: IngestExecutionOptions
): Promise<ExecuteIngestResult> {
  const plan = await preflightIngestBatch(bodyInput, authInput, state, options);
  return applyIngestBatchPlan(state, plan);
}
