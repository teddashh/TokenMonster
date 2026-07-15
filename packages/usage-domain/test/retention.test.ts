import { describe, expect, it } from "vitest";

import {
  applyEnrollmentDeletionPlan,
  applyThirtyDayCompactionPlan,
  createUsageDomainState,
  executeIngestBatch,
  planEnrollmentDeletion,
  planThirtyDayCompaction,
  projectPublicAggregate,
  type UsageDomainState
} from "../src/index.js";
import { auth, testBucket, testSnapshot } from "./helpers.js";

const MAX_SAFE = "9007199254740991";

async function buildCohort(
  count: number,
  input = "100"
): Promise<UsageDomainState> {
  let state = createUsageDomainState();
  for (let index = 0; index < count; index += 1) {
    const result = await executeIngestBatch(
      testSnapshot({
        generatedAt: "2026-06-01T12:00:00.000Z",
        buckets: [
          testBucket({
            bucketStart: "2026-06-01T00:00:00.000Z",
            input,
            output: "0",
            cacheRead: "0",
            cacheWrite: "0",
            reasoning: "0",
            other: "0"
          })
        ]
      }),
      auth(`cohort-${index.toString().padStart(2, "0")}`),
      state,
      { receivedAt: "2026-06-01T12:01:00.000Z" }
    );
    state = result.state;
  }
  return state;
}

describe("retention, anonymous compaction, and public sums", () => {
  it("drops an expired k=19 cohort instead of publishing it", async () => {
    let state = await buildCohort(19);
    state = (
      await executeIngestBatch(
        testSnapshot({
          batchIndex: 2,
          generatedAt: "2026-06-01T12:00:00.000Z",
          buckets: [
            testBucket({
              bucketStart: "2026-06-01T00:00:00.000Z",
              provider: "google",
              modelFamily: "gemini-flash",
              tool: "gemini-cli"
            })
          ]
        }),
        auth("cohort-00"),
        state,
        { receivedAt: "2026-06-01T12:02:00.000Z" }
      )
    ).state;
    const plan = planThirtyDayCompaction(state, {
      asOf: "2026-07-01T00:00:00.000Z"
    });

    expect(plan.groups).toEqual([
      {
        periodStart: "2026-06-01T00:00:00.000Z",
        action: "drop",
        rowCount: 20,
        uniqueEnrollmentCount: 19
      }
    ]);
    expect(plan.rollups).toHaveLength(0);

    const compacted = applyThirtyDayCompactionPlan(state, plan);
    expect(compacted.rows.size).toBe(0);
    expect(compacted.authorityBindings.size).toBe(0);
    expect(compacted.anonymousRollups.size).toBe(0);
    expect(projectPublicAggregate(compacted).allTime.total).toBe("0");
  });

  it("creates a coarse ID-free rollup at k=20 with BigInt string totals", async () => {
    const state = await buildCohort(20, MAX_SAFE);
    expect(projectPublicAggregate(state).current.total).toBe(
      "180143985094819820"
    );

    const plan = planThirtyDayCompaction(state, {
      asOf: "2026-07-01T00:00:00.000Z"
    });
    expect(plan.groups[0]).toMatchObject({
      action: "rollup",
      uniqueEnrollmentCount: 20
    });
    expect(plan.rollups).toHaveLength(1);
    expect(plan.rollups[0]).toMatchObject({
      periodStart: "2026-06-01T00:00:00.000Z",
      periodEnd: "2026-06-02T00:00:00.000Z",
      scope: "all",
      eligibleContributorCount: 20,
      tokens: { total: "180143985094819820" }
    });
    const serializedRollup = JSON.stringify(plan.rollups[0]);
    expect(serializedRollup).not.toContain("enrollmentId");
    expect(serializedRollup).not.toContain("cohort-00");
    expect(serializedRollup).not.toContain("modelFamily");
    expect(serializedRollup).not.toContain("tool");

    const compacted = applyThirtyDayCompactionPlan(state, plan);
    const aggregate = projectPublicAggregate(compacted);
    expect(aggregate.current.total).toBe("0");
    expect(aggregate.anonymous.total).toBe("180143985094819820");
    expect(aggregate.allTime.total).toBe("180143985094819820");
  });

  it("does not let a zero-only enrollment satisfy the k=20 privacy gate", async () => {
    let state = await buildCohort(19);
    state = (
      await executeIngestBatch(
        testSnapshot({
          generatedAt: "2026-06-01T12:00:00.000Z",
          buckets: [
            testBucket({
              bucketStart: "2026-06-01T00:00:00.000Z",
              input: "0",
              output: "0",
              cacheRead: "0",
              cacheWrite: "0",
              reasoning: "0",
              other: "0"
            })
          ]
        }),
        auth("zero-only-20th"),
        state,
        { receivedAt: "2026-06-01T12:01:00.000Z" }
      )
    ).state;

    const plan = planThirtyDayCompaction(state, {
      asOf: "2026-07-01T00:00:00.000Z"
    });
    expect(plan.groups[0]).toMatchObject({
      action: "drop",
      rowCount: 20,
      uniqueEnrollmentCount: 19
    });
    expect(plan.rollups).toHaveLength(0);
  });

  it("combines anonymous history with current rows and deletes only attributable current data", async () => {
    const historical = await buildCohort(20, MAX_SAFE);
    let state = applyThirtyDayCompactionPlan(
      historical,
      planThirtyDayCompaction(historical, {
        asOf: "2026-07-01T00:00:00.000Z"
      })
    );
    const current = await executeIngestBatch(
      testSnapshot({
        batchIndex: 2,
        generatedAt: "2026-07-01T12:00:00.000Z",
        buckets: [
          testBucket({
            bucketStart: "2026-07-01T00:00:00.000Z",
            input: "10",
            output: "0",
            cacheRead: "0",
            cacheWrite: "0",
            reasoning: "0",
            other: "0"
          })
        ]
      }),
      auth("cohort-00"),
      state,
      { receivedAt: "2026-07-01T12:01:00.000Z" }
    );
    state = current.state;

    expect(projectPublicAggregate(state)).toMatchObject({
      current: { total: "10" },
      anonymous: { total: "180143985094819820" },
      allTime: { total: "180143985094819830" },
      activeCurrentContributors: "1"
    });

    const deletion = planEnrollmentDeletion(state, auth("cohort-00"));
    expect(deletion.anonymousHistoricalTotalsRetained).toBe(true);
    expect(deletion.deleteRowKeys).toHaveLength(1);
    const deleted = applyEnrollmentDeletionPlan(state, deletion);
    expect(deleted.rows.size).toBe(0);
    expect(deleted.anonymousRollups.size).toBe(1);
    expect(projectPublicAggregate(deleted).allTime.total).toBe(
      "180143985094819820"
    );
  });

  it("expires batch receipts at seven days without expiring 30-day rows", async () => {
    const ingested = await executeIngestBatch(
      testSnapshot({
        generatedAt: "2026-07-01T00:00:00.000Z",
        buckets: [testBucket({ bucketStart: "2026-07-01T00:00:00.000Z" })]
      }),
      auth(),
      createUsageDomainState(),
      { receivedAt: "2026-07-01T01:00:00.000Z" }
    );
    const plan = planThirtyDayCompaction(ingested.state, {
      asOf: "2026-07-08T01:00:00.000Z"
    });

    expect(plan.deleteBatchReceiptKeys).toHaveLength(1);
    expect(plan.deleteRowKeys).toHaveLength(0);
    expect(plan.deleteAuthorityKeys).toHaveLength(0);
    const cleaned = applyThirtyDayCompactionPlan(ingested.state, plan);
    expect(cleaned.batchReceipts.size).toBe(0);
    expect(cleaned.rows.size).toBe(1);
    expect(cleaned.authorityBindings.size).toBe(1);
  });

  it("does not compact a row before its exact 30-day boundary", async () => {
    const state = await buildCohort(20);
    const plan = planThirtyDayCompaction(state, {
      asOf: "2026-06-30T23:59:59.999Z"
    });
    expect(plan.deleteRowKeys).toHaveLength(0);
    expect(plan.rollups).toHaveLength(0);
  });
});
