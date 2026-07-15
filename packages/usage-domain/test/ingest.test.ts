import { describe, expect, it } from "vitest";

import {
  UsageDomainError,
  applyIngestBatchPlan,
  createUsageDomainState,
  executeIngestBatch,
  preflightIngestBatch,
  projectPublicAggregate
} from "../src/index.js";
import {
  RECEIVED_AT,
  auth,
  testBucket,
  testSnapshot
} from "./helpers.js";

const options = { receivedAt: RECEIVED_AT };

describe("atomic absolute ingest decisions", () => {
  it("is idempotent across 100 whole-batch replays", async () => {
    const body = testSnapshot();
    let state = createUsageDomainState();
    let firstRowHash = "";

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await executeIngestBatch(body, auth(), state, options);
      if (attempt === 0) {
        expect(result.replayed).toBe(false);
        expect(result.receipt.summary.appliedBuckets).toBe(1);
        firstRowHash = [...result.state.rows.values()][0]!.rowHash;
      } else {
        expect(result.replayed).toBe(true);
        expect(result.state).toBe(state);
      }
      state = result.state;
    }

    expect(state.rows.size).toBe(1);
    expect(state.batchReceipts.size).toBe(1);
    expect([...state.rows.values()][0]?.rowHash).toBe(firstRowHash);
  });

  it("classifies an identical row in a new batch as an idempotent no-op", async () => {
    const first = await executeIngestBatch(
      testSnapshot({ batchIndex: 1 }),
      auth(),
      createUsageDomainState(),
      options
    );
    const second = await executeIngestBatch(
      testSnapshot({ batchIndex: 2 }),
      auth(),
      first.state,
      options
    );

    expect(second.replayed).toBe(false);
    expect(second.decisions[0]?.status).toBe("idempotent");
    expect(second.receipt.summary).toMatchObject({
      appliedBuckets: 0,
      idempotentBuckets: 1
    });
    expect(second.state.rows.size).toBe(1);
  });

  it("keeps r3 when r1 and r2 arrive out of order", async () => {
    let state = createUsageDomainState();
    for (const [batchIndex, revision] of [
      [3, 3],
      [1, 1],
      [2, 2]
    ] as const) {
      const result = await executeIngestBatch(
        testSnapshot({
          batchIndex,
          buckets: [testBucket({ revision, input: String(revision * 100) })]
        }),
        auth(),
        state,
        options
      );
      if (revision < 3) {
        expect(result.receipt.summary.staleBuckets).toBe(1);
      }
      state = result.state;
    }

    expect([...state.rows.values()][0]).toMatchObject({
      revision: 3,
      tokens: { input: "300" }
    });
  });

  it("replaces with higher-revision downward and zero corrections", async () => {
    let state = createUsageDomainState();
    for (const [batchIndex, revision, input] of [
      [1, 1, "1000"],
      [2, 2, "10"],
      [3, 3, "0"]
    ] as const) {
      const zero = input === "0";
      const result = await executeIngestBatch(
        testSnapshot({
          batchIndex,
          buckets: [
            testBucket({
              revision,
              input,
              output: zero ? "0" : "20",
              cacheRead: zero ? "0" : "10",
              cacheWrite: zero ? "0" : "5",
              reasoning: zero ? "0" : "4",
              other: zero ? "0" : "1"
            })
          ]
        }),
        auth(),
        state,
        options
      );
      expect(result.receipt.summary.appliedBuckets).toBe(1);
      state = result.state;
    }

    expect([...state.rows.values()][0]).toMatchObject({
      revision: 3,
      tokens: {
        input: "0",
        output: "0",
        cacheRead: "0",
        cacheWrite: "0",
        reasoning: "0",
        other: "0",
        total: "0"
      }
    });
    expect(projectPublicAggregate(state).activeCurrentContributors).toBe("0");

    const mixed = await executeIngestBatch(
      testSnapshot({
        batchIndex: 4,
        buckets: [
          testBucket({
            provider: "google",
            modelFamily: "gemini-flash",
            tool: "gemini-cli",
            input: "1",
            output: "0",
            cacheRead: "0",
            cacheWrite: "0",
            reasoning: "0",
            other: "0"
          })
        ]
      }),
      auth(),
      state,
      options
    );
    expect(projectPublicAggregate(mixed.state).activeCurrentContributors).toBe(
      "1"
    );
  });

  it("rejects equal-revision different hashes with no partial mutations", async () => {
    const initial = await executeIngestBatch(
      testSnapshot(),
      auth(),
      createUsageDomainState(),
      options
    );
    const before = initial.state;
    const conflictingBatch = testSnapshot({
      batchIndex: 2,
      buckets: [
        testBucket({
          provider: "google",
          modelFamily: "gemini-flash",
          tool: "gemini-cli"
        }),
        testBucket({ input: "999", revision: 1 })
      ]
    });

    await expect(
      preflightIngestBatch(conflictingBatch, auth(), before, options)
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(before.rows.size).toBe(1);
    expect(before.batchReceipts.size).toBe(1);
    expect(before.authorityBindings.size).toBe(1);
    expect([...before.rows.values()][0]?.tokens.input).toBe("100");
  });

  it("rejects reuse of a batch ID with a changed payload", async () => {
    const initial = await executeIngestBatch(
      testSnapshot(),
      auth(),
      createUsageDomainState(),
      options
    );
    await expect(
      preflightIngestBatch(
        testSnapshot({ buckets: [testBucket({ revision: 2 })] }),
        auth(),
        initial.state,
        options
      )
    ).rejects.toMatchObject({ code: "BATCH_ID_REUSE" });
  });

  it("binds collector authority by enrollment and UTC day", async () => {
    const initial = await executeIngestBatch(
      testSnapshot({ kind: "tokscale" }),
      auth(),
      createUsageDomainState(),
      options
    );
    await expect(
      preflightIngestBatch(
        testSnapshot({
          batchIndex: 2,
          kind: "tokentracker-bridge",
          buckets: [
            testBucket({
              provider: "openai",
              modelFamily: "openai-codex",
              tool: "codex-cli"
            })
          ]
        }),
        auth(),
        initial.state,
        options
      )
    ).rejects.toMatchObject({ code: "AUTHORITY_CONFLICT" });

    const nextDay = await executeIngestBatch(
      testSnapshot({
        batchIndex: 3,
        kind: "tokentracker-bridge",
        generatedAt: "2026-07-16T12:00:00.000Z",
        buckets: [testBucket({ bucketStart: "2026-07-16T00:00:00.000Z" })]
      }),
      auth(),
      initial.state,
      { receivedAt: "2026-07-16T12:01:00.000Z" }
    );
    expect(nextDay.state.authorityBindings.size).toBe(2);
  });

  it("rejects a same-kind adapter or source version change within a bound day", async () => {
    const initial = await executeIngestBatch(
      testSnapshot(),
      auth(),
      createUsageDomainState(),
      options
    );
    for (const collectorPatch of [
      { adapterVersion: "0.2.0" },
      { sourceVersion: "4.5.3" }
    ]) {
      const changed = testSnapshot({
        batchIndex: collectorPatch.adapterVersion === undefined ? 2 : 3,
        buckets: [
          testBucket({
            provider: "openai",
            modelFamily: "openai-codex",
            tool: "codex-cli"
          })
        ]
      });
      changed.collector = { ...changed.collector, ...collectorPatch };
      await expect(
        preflightIngestBatch(changed, auth(), initial.state, options)
      ).rejects.toMatchObject({ code: "AUTHORITY_CONFLICT" });
    }
  });

  it("rejects forbidden client-provided identity and hash fields", async () => {
    for (const field of [
      "enrollmentId",
      "contributorId",
      "bucketId",
      "payloadHash",
      "authorization"
    ]) {
      const body: Record<string, unknown> = { ...testSnapshot(), [field]: "forbidden" };
      await expect(
        preflightIngestBatch(body, auth(), createUsageDomainState(), options)
      ).rejects.toEqual(
        expect.objectContaining<Partial<UsageDomainError>>({
          code: "SCHEMA_INVALID"
        })
      );
    }
  });

  it("guards apply against a concurrent state change", async () => {
    const empty = createUsageDomainState();
    const plan = await preflightIngestBatch(testSnapshot(), auth(), empty, options);
    const concurrent = {
      ...empty,
      version: 1
    };
    expect(() => applyIngestBatchPlan(concurrent, plan)).toThrowError(
      expect.objectContaining<Partial<UsageDomainError>>({ code: "PLAN_STALE" })
    );
  });

  it("rejects buckets at the 30-day retention boundary", async () => {
    await expect(
      preflightIngestBatch(
        testSnapshot({
          generatedAt: "2026-06-15T12:00:00.000Z",
          buckets: [testBucket({ bucketStart: "2026-06-15T00:00:00.000Z" })]
        }),
        auth(),
        createUsageDomainState(),
        { receivedAt: "2026-07-15T00:00:00.000Z" }
      )
    ).rejects.toMatchObject({ code: "BUCKET_OUTSIDE_RETENTION" });
  });

  it("fails closed on a bucket after receivedAt's current UTC day", async () => {
    await expect(
      preflightIngestBatch(
        testSnapshot({
          generatedAt: "2026-07-16T00:00:00.000Z",
          buckets: [testBucket({ bucketStart: "2026-07-16T00:00:00.000Z" })]
        }),
        auth(),
        createUsageDomainState(),
        { receivedAt: "2026-07-15T23:59:59.999Z" }
      )
    ).rejects.toMatchObject({ code: "BUCKET_OUTSIDE_RETENTION" });
  });
});
