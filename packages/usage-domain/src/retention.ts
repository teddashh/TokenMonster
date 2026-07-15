import { canonicalizeJson } from "./canonical-json.js";
import { sumTokenLedgers } from "./aggregate.js";
import { UsageDomainError } from "./errors.js";
import { canonicalAnonymousRollupKey } from "./keys.js";
import type {
  AnonymousCoarseRollup,
  CanonicalUsageRow,
  EnrollmentDeletionPlan,
  ThirtyDayCompactionPlan,
  UsageDomainState
} from "./types.js";
import {
  parseAuthenticatedEnrollment,
  parseReceivedAt
} from "./validation.js";

export const IDENTIFIABLE_RETENTION_DAYS = 30;
export const BATCH_RECEIPT_RETENTION_DAYS = 7;
export const PUBLIC_ANONYMITY_THRESHOLD = 20;
export const ANONYMOUS_COMPACTION_VERSION = "1" as const;

const IDENTIFIABLE_RETENTION_MS =
  IDENTIFIABLE_RETENTION_DAYS * 86_400_000;
const BATCH_RECEIPT_RETENTION_MS =
  BATCH_RECEIPT_RETENTION_DAYS * 86_400_000;

export interface ThirtyDayCompactionOptions {
  readonly asOf: string;
}

function isExpired(bucketStart: string, asOfMs: number): boolean {
  const bucketMs = Date.parse(bucketStart);
  if (!Number.isFinite(bucketMs)) {
    throw new UsageDomainError(
      "STATE_INVALID",
      "Current usage state contains an invalid UTC bucket."
    );
  }
  return bucketMs + IDENTIFIABLE_RETENTION_MS <= asOfMs;
}

function nextUtcDay(bucketStart: string): string {
  return new Date(Date.parse(bucketStart) + 86_400_000).toISOString();
}

function buildAnonymousRollup(
  periodStart: string,
  rows: readonly CanonicalUsageRow[],
  uniqueEnrollmentCount: number
): AnonymousCoarseRollup {
  const periodEnd = nextUtcDay(periodStart);
  const key = canonicalAnonymousRollupKey({
    periodStart,
    periodEnd,
    scope: "all",
    compactionVersion: ANONYMOUS_COMPACTION_VERSION
  });
  return Object.freeze({
    key,
    periodStart,
    periodEnd,
    scope: "all",
    compactionVersion: ANONYMOUS_COMPACTION_VERSION,
    eligibleContributorCount: uniqueEnrollmentCount,
    tokens: sumTokenLedgers(rows.map(({ tokens }) => tokens))
  });
}

function countEligibleEnrollments(rows: readonly CanonicalUsageRow[]): number {
  const totalsByEnrollment = new Map<string, bigint>();
  for (const { enrollmentId, tokens } of rows) {
    totalsByEnrollment.set(
      enrollmentId,
      (totalsByEnrollment.get(enrollmentId) ?? 0n) + BigInt(tokens.total)
    );
  }
  return [...totalsByEnrollment.values()].filter((total) => total > 0n).length;
}

export function planThirtyDayCompaction(
  state: UsageDomainState,
  options: ThirtyDayCompactionOptions
): ThirtyDayCompactionPlan {
  const asOf = parseReceivedAt(options.asOf);
  const asOfMs = Date.parse(asOf);
  const expiredRows = [...state.rows.values()]
    .filter(({ bucketStart }) => isExpired(bucketStart, asOfMs))
    .sort((left, right) => left.key.localeCompare(right.key));
  const byPeriod = new Map<string, CanonicalUsageRow[]>();
  for (const row of expiredRows) {
    const group = byPeriod.get(row.bucketStart) ?? [];
    group.push(row);
    byPeriod.set(row.bucketStart, group);
  }

  const rollups: AnonymousCoarseRollup[] = [];
  const groups = [...byPeriod.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([periodStart, rows]) => {
      const uniqueEnrollmentCount = countEligibleEnrollments(rows);
      const action =
        uniqueEnrollmentCount >= PUBLIC_ANONYMITY_THRESHOLD
          ? "rollup"
          : "drop";
      if (action === "rollup") {
        rollups.push(
          buildAnonymousRollup(periodStart, rows, uniqueEnrollmentCount)
        );
      }
      return Object.freeze({
        periodStart,
        action,
        rowCount: rows.length,
        uniqueEnrollmentCount
      });
    });

  const deleteAuthorityKeys = [...state.authorityBindings.values()]
    .filter(({ bucketStart }) => isExpired(bucketStart, asOfMs))
    .map(({ key }) => key)
    .sort();
  const deleteBatchReceiptKeys = [...state.batchReceipts.values()]
    .filter(({ receivedAt }) => {
      const receivedAtMs = Date.parse(receivedAt);
      if (!Number.isFinite(receivedAtMs)) {
        throw new UsageDomainError(
          "STATE_INVALID",
          "Batch receipt state contains an invalid receivedAt timestamp."
        );
      }
      return receivedAtMs + BATCH_RECEIPT_RETENTION_MS <= asOfMs;
    })
    .map(({ key }) => key)
    .sort();

  return Object.freeze({
    expectedStateVersion: state.version,
    asOf,
    deleteRowKeys: Object.freeze(expiredRows.map(({ key }) => key)),
    deleteAuthorityKeys: Object.freeze(deleteAuthorityKeys),
    deleteBatchReceiptKeys: Object.freeze(deleteBatchReceiptKeys),
    rollups: Object.freeze(rollups),
    groups: Object.freeze(groups)
  });
}

function assertPlanFresh(state: UsageDomainState, expectedVersion: number): void {
  if (state.version !== expectedVersion) {
    throw new UsageDomainError(
      "PLAN_STALE",
      "The retention plan was based on a stale domain state version."
    );
  }
}

export function applyThirtyDayCompactionPlan(
  state: UsageDomainState,
  plan: ThirtyDayCompactionPlan
): UsageDomainState {
  assertPlanFresh(state, plan.expectedStateVersion);
  if (
    plan.deleteRowKeys.length === 0 &&
    plan.deleteAuthorityKeys.length === 0 &&
    plan.deleteBatchReceiptKeys.length === 0 &&
    plan.rollups.length === 0
  ) {
    return state;
  }

  const rows = new Map(state.rows);
  const authorityBindings = new Map(state.authorityBindings);
  const batchReceipts = new Map(state.batchReceipts);
  const anonymousRollups = new Map(state.anonymousRollups);
  for (const key of plan.deleteRowKeys) rows.delete(key);
  for (const key of plan.deleteAuthorityKeys) authorityBindings.delete(key);
  for (const key of plan.deleteBatchReceiptKeys) batchReceipts.delete(key);
  for (const rollup of plan.rollups) {
    const existing = anonymousRollups.get(rollup.key);
    if (
      existing !== undefined &&
      canonicalizeJson(existing) !== canonicalizeJson(rollup)
    ) {
      throw new UsageDomainError(
        "ANONYMOUS_ROLLUP_CONFLICT",
        "An anonymous rollup key already has different canonical totals."
      );
    }
    anonymousRollups.set(rollup.key, rollup);
  }

  return Object.freeze({
    version: state.version + 1,
    rows,
    authorityBindings,
    batchReceipts,
    anonymousRollups
  });
}

export function planEnrollmentDeletion(
  state: UsageDomainState,
  authInput: unknown
): EnrollmentDeletionPlan {
  const { enrollmentId } = parseAuthenticatedEnrollment(authInput);
  const deleteRowKeys = [...state.rows.values()]
    .filter((row) => row.enrollmentId === enrollmentId)
    .map(({ key }) => key)
    .sort();
  const deleteAuthorityKeys = [...state.authorityBindings.values()]
    .filter((binding) => binding.enrollmentId === enrollmentId)
    .map(({ key }) => key)
    .sort();
  const deleteBatchReceiptKeys = [...state.batchReceipts.values()]
    .filter((receipt) => receipt.enrollmentId === enrollmentId)
    .map(({ key }) => key)
    .sort();

  return Object.freeze({
    expectedStateVersion: state.version,
    enrollmentId,
    deleteRowKeys: Object.freeze(deleteRowKeys),
    deleteAuthorityKeys: Object.freeze(deleteAuthorityKeys),
    deleteBatchReceiptKeys: Object.freeze(deleteBatchReceiptKeys),
    anonymousHistoricalTotalsRetained: state.anonymousRollups.size > 0
  });
}

export function applyEnrollmentDeletionPlan(
  state: UsageDomainState,
  plan: EnrollmentDeletionPlan
): UsageDomainState {
  assertPlanFresh(state, plan.expectedStateVersion);
  if (
    plan.deleteRowKeys.length === 0 &&
    plan.deleteAuthorityKeys.length === 0 &&
    plan.deleteBatchReceiptKeys.length === 0
  ) {
    return state;
  }

  const rows = new Map(state.rows);
  const authorityBindings = new Map(state.authorityBindings);
  const batchReceipts = new Map(state.batchReceipts);
  for (const key of plan.deleteRowKeys) rows.delete(key);
  for (const key of plan.deleteAuthorityKeys) authorityBindings.delete(key);
  for (const key of plan.deleteBatchReceiptKeys) batchReceipts.delete(key);

  return Object.freeze({
    version: state.version + 1,
    rows,
    authorityBindings,
    batchReceipts,
    anonymousRollups: state.anonymousRollups
  });
}
