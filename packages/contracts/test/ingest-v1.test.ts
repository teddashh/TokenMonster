import { describe, expect, it } from "vitest";

import {
  COLLECTOR_KINDS_V1,
  IngestSnapshotV1Schema,
  deserializeIngestSnapshotV1,
  parseIngestSnapshotV1,
  serializeIngestSnapshotV1,
  sumTokenComponentsV1,
  tokenTotalIsConsistentV1
} from "../src/index.js";

function validPayload(): Record<string, unknown> {
  return {
    schemaVersion: "1",
    batchId: "550e8400-e29b-41d4-a716-446655440000",
    generatedAt: "2026-07-15T12:34:56.000Z",
    collector: {
      kind: "tokscale",
      adapterVersion: "0.1.0",
      sourceVersion: "4.5.2"
    },
    buckets: [
      {
        bucketStart: "2026-07-15T00:00:00.000Z",
        provider: "anthropic",
        modelFamily: "claude-sonnet",
        tool: "claude-code",
        valueQuality: "exact",
        revision: 1,
        tokens: {
          input: "1000",
          output: "500",
          cacheRead: "250",
          cacheWrite: "100",
          reasoning: "100",
          other: "50",
          total: "1900"
        }
      }
    ]
  };
}

function firstBucket(payload: Record<string, unknown>): Record<string, unknown> {
  return (payload["buckets"] as Array<Record<string, unknown>>)[0]!;
}

function tokenCounts(payload: Record<string, unknown>): Record<string, unknown> {
  return firstBucket(payload)["tokens"] as Record<string, unknown>;
}

describe("IngestSnapshotV1Schema", () => {
  it("accepts a valid strict payload and round-trips through JSON", () => {
    const payload = validPayload();
    const parsed = parseIngestSnapshotV1(payload);
    const serialized = serializeIngestSnapshotV1(parsed);

    expect(deserializeIngestSnapshotV1(serialized)).toEqual(parsed);
    expect(serialized).not.toContain("bigint");
    expect(parsed.buckets[0]?.tokens.total).toBe("1900");
  });

  it("supports every declared collector kind and rejects unknown kinds", () => {
    for (const kind of COLLECTOR_KINDS_V1) {
      const payload = validPayload();
      (payload["collector"] as Record<string, unknown>)["kind"] = kind;
      expect(IngestSnapshotV1Schema.safeParse(payload).success).toBe(true);
    }

    const payload = validPayload();
    (payload["collector"] as Record<string, unknown>)["kind"] =
      "browser-scraper";
    expect(IngestSnapshotV1Schema.safeParse(payload).success).toBe(false);
  });

  it("requires a SemVer collector version", () => {
    const payload = validPayload();
    (payload["collector"] as Record<string, unknown>)["adapterVersion"] =
      "latest";
    expect(IngestSnapshotV1Schema.safeParse(payload).success).toBe(false);

    const sourcePayload = validPayload();
    (sourcePayload["collector"] as Record<string, unknown>)["sourceVersion"] =
      "current";
    expect(IngestSnapshotV1Schema.safeParse(sourcePayload).success).toBe(false);
  });

  it("rejects unknown privacy-sensitive fields at every strict boundary", () => {
    const topLevelFields = [
      "prompt",
      "response",
      "path",
      "project",
      "account",
      "eventCount",
      "enrollmentId",
      "bucketId",
      "payloadHash",
      "authorization",
      "apiKey",
      "authToken"
    ];

    for (const field of topLevelFields) {
      const payload = validPayload();
      payload[field] = "must-not-leave-the-device";
      expect(
        IngestSnapshotV1Schema.safeParse(payload).success,
        field
      ).toBe(false);
    }

    const bucketPayload = validPayload();
    firstBucket(bucketPayload)["project"] = "secret-repository";
    expect(IngestSnapshotV1Schema.safeParse(bucketPayload).success).toBe(false);

    const localCountPayload = validPayload();
    firstBucket(localCountPayload)["eventCount"] = 7;
    expect(IngestSnapshotV1Schema.safeParse(localCountPayload).success).toBe(
      false
    );

    const collectorPayload = validPayload();
    (collectorPayload["collector"] as Record<string, unknown>)["apiKey"] =
      "secret";
    expect(IngestSnapshotV1Schema.safeParse(collectorPayload).success).toBe(
      false
    );

    const tokenPayload = validPayload();
    tokenCounts(tokenPayload)["response"] = "private";
    expect(IngestSnapshotV1Schema.safeParse(tokenPayload).success).toBe(false);
  });

  it.each([
    ["negative", "-1"],
    ["fractional", "1.5"],
    ["scientific notation", "1e3"],
    ["leading zero", "01"],
    ["signed", "+1"],
    ["empty", ""],
    ["number instead of a string", 1]
  ])("rejects %s token counts", (_description, invalidCount) => {
    const payload = validPayload();
    tokenCounts(payload)["input"] = invalidCount;
    expect(IngestSnapshotV1Schema.safeParse(payload).success).toBe(false);
  });

  it("rejects token strings above the public contract digit limit", () => {
    const payload = validPayload();
    tokenCounts(payload)["input"] = "1".repeat(17);
    expect(IngestSnapshotV1Schema.safeParse(payload).success).toBe(false);
  });

  it("round-trips Number.MAX_SAFE_INTEGER as a decimal string", () => {
    const payload = validPayload();
    const counts = tokenCounts(payload);
    counts["input"] = "9007199254740991";
    counts["output"] = "0";
    counts["cacheRead"] = "0";
    counts["cacheWrite"] = "0";
    counts["reasoning"] = "0";
    counts["other"] = "0";
    counts["total"] = "9007199254740991";

    const parsed = parseIngestSnapshotV1(payload);
    const serialized = serializeIngestSnapshotV1(parsed);
    expect(parsed.buckets[0]?.tokens.total).toBe("9007199254740991");
    expect(deserializeIngestSnapshotV1(serialized)).toEqual(parsed);
  });

  it("rejects a decimal token count above Number.MAX_SAFE_INTEGER", () => {
    const payload = validPayload();
    tokenCounts(payload)["input"] = "9007199254740992";
    tokenCounts(payload)["total"] = "9007199254740992";

    expect(IngestSnapshotV1Schema.safeParse(payload).success).toBe(false);
  });

  it("enforces total token consistency in the runtime schema and helper", () => {
    const payload = validPayload();
    tokenCounts(payload)["total"] = "1901";

    const result = IngestSnapshotV1Schema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue) =>
            issue.path.join(".") === "buckets.0.tokens.total" &&
            issue.message.includes("total must equal")
        )
      ).toBe(true);
    }

    const valid = parseIngestSnapshotV1(validPayload()).buckets[0]!.tokens;
    expect(tokenTotalIsConsistentV1(valid)).toBe(true);
    expect(sumTokenComponentsV1(valid)).toBe("1900");
  });

  it("treats reasoning as an informational subset of output", () => {
    const payload = validPayload();
    tokenCounts(payload)["reasoning"] = "499";

    const parsed = parseIngestSnapshotV1(payload);
    expect(parsed.buckets[0]?.tokens.reasoning).toBe("499");
    expect(parsed.buckets[0]?.tokens.total).toBe("1900");
    expect(tokenTotalIsConsistentV1(parsed.buckets[0]!.tokens)).toBe(true);
  });

  it("rejects reasoning greater than output", () => {
    const payload = validPayload();
    tokenCounts(payload)["reasoning"] = "501";

    expect(IngestSnapshotV1Schema.safeParse(payload).success).toBe(false);
  });

  it.each([
    "2019-12-31T00:00:00.000Z",
    "2100-01-01T00:00:00.000Z",
    "2026-02-30T00:00:00.000Z",
    "2026-07-15T12:00:00.000Z",
    "2026-07-15",
    "2026-07-15T00:00:00+00:00"
  ])("rejects an invalid or unreasonable daily bucket: %s", (bucketStart) => {
    const payload = validPayload();
    firstBucket(payload)["bucketStart"] = bucketStart;
    expect(IngestSnapshotV1Schema.safeParse(payload).success).toBe(false);
  });

  it.each([
    "2019-12-31T23:59:59.999Z",
    "2100-01-01T00:00:00.000Z",
    "2026-02-30T12:00:00.000Z",
    "2026-07-15T25:00:00.000Z",
    "2026-07-15T12:00:00+00:00"
  ])("rejects an invalid or unreasonable generatedAt: %s", (generatedAt) => {
    const payload = validPayload();
    payload["generatedAt"] = generatedAt;
    expect(IngestSnapshotV1Schema.safeParse(payload).success).toBe(false);
  });

  it.each([-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid bucket revision: %s",
    (revision) => {
      const payload = validPayload();
      firstBucket(payload)["revision"] = revision;
      expect(IngestSnapshotV1Schema.safeParse(payload).success).toBe(false);
    }
  );

  it("requires a UUID batch id", () => {
    const payload = validPayload();
    payload["batchId"] = "batch-1";
    expect(IngestSnapshotV1Schema.safeParse(payload).success).toBe(false);
  });

  it("accepts at most 30 daily aggregate buckets per public batch", () => {
    const payload = validPayload();
    const sourceBucket = firstBucket(payload);
    const buckets = Array.from({ length: 30 }, (_unused, index) => {
      const bucket = structuredClone(sourceBucket);
      bucket["bucketStart"] = new Date(
        Date.UTC(2026, 5, 1 + index)
      ).toISOString();
      return bucket;
    });
    payload["buckets"] = buckets;

    expect(IngestSnapshotV1Schema.safeParse(payload).success).toBe(true);

    const thirtyFirstBucket = structuredClone(sourceBucket);
    thirtyFirstBucket["bucketStart"] = "2026-07-01T00:00:00.000Z";
    buckets.push(thirtyFirstBucket);

    expect(IngestSnapshotV1Schema.safeParse(payload).success).toBe(false);
  });

  it("rejects duplicate daily aggregate keys within one batch", () => {
    const payload = validPayload();
    const duplicate = structuredClone(firstBucket(payload));
    duplicate["revision"] = 2;
    (payload["buckets"] as Array<Record<string, unknown>>).push(duplicate);

    expect(IngestSnapshotV1Schema.safeParse(payload).success).toBe(false);
  });
});
