import { describe, expect, it } from "vitest";

import {
  IngestSnapshotV2Schema,
  PERMANENT_SIDECAR_COLLECTOR_IDENTITY_V2,
  SupportedIngestSnapshotSchema,
  deserializeIngestSnapshotV2,
  parseIngestSnapshotV2,
  serializeIngestSnapshotV2
} from "../src/index.js";

function validPayload(): Record<string, unknown> {
  return {
    schemaVersion: "2",
    batchId: "550e8400-e29b-41d4-a716-446655440002",
    generatedAt: "2026-07-18T12:34:56.000Z",
    collector: {
      kind: "tokentracker-sidecar",
      adapterVersion: "0.1.0",
      sourceVersion: "0.80.0"
    },
    buckets: [
      {
        bucketStart: "2026-07-18T00:00:00.000Z",
        provider: "other",
        modelFamily: "glm",
        tool: "agy",
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

describe("IngestSnapshotV2Schema", () => {
  it("accepts and round-trips the permanent-sidecar envelope", () => {
    const parsed = parseIngestSnapshotV2(validPayload());
    expect(parsed.collector).toEqual(
      PERMANENT_SIDECAR_COLLECTOR_IDENTITY_V2
    );
    expect(deserializeIngestSnapshotV2(serializeIngestSnapshotV2(parsed)))
      .toEqual(parsed);
  });

  it("rejects legacy, unknown, and forbidden collector data", () => {
    for (const kind of ["tokscale", "tokentracker-bridge", "browser-scraper"]) {
      const payload = validPayload();
      (payload["collector"] as Record<string, unknown>)["kind"] = kind;
      expect(IngestSnapshotV2Schema.safeParse(payload).success, kind).toBe(false);
    }

    const forbidden = validPayload();
    (forbidden["collector"] as Record<string, unknown>)["apiKey"] = "secret";
    expect(IngestSnapshotV2Schema.safeParse(forbidden).success).toBe(false);
  });

  it("rejects a wrong schema version, unknown fields, and invalid versions", () => {
    for (const schemaVersion of ["1", "3", 2]) {
      const payload = validPayload();
      payload["schemaVersion"] = schemaVersion;
      expect(IngestSnapshotV2Schema.safeParse(payload).success).toBe(false);
    }

    const unknown = validPayload();
    unknown["projectPath"] = "/private/project";
    expect(IngestSnapshotV2Schema.safeParse(unknown).success).toBe(false);

    for (const field of ["adapterVersion", "sourceVersion"]) {
      const payload = validPayload();
      (payload["collector"] as Record<string, unknown>)[field] = "latest";
      expect(IngestSnapshotV2Schema.safeParse(payload).success).toBe(false);
    }
  });

  it("reuses V1 bucket limits, totals, UTC days, and duplicate-key rules", () => {
    const inconsistent = validPayload();
    const bucket = (inconsistent["buckets"] as Array<Record<string, unknown>>)[0]!;
    (bucket["tokens"] as Record<string, unknown>)["total"] = "1901";
    expect(IngestSnapshotV2Schema.safeParse(inconsistent).success).toBe(false);

    const duplicate = validPayload();
    const original = (duplicate["buckets"] as Array<Record<string, unknown>>)[0]!;
    duplicate["buckets"] = [original, structuredClone(original)];
    expect(IngestSnapshotV2Schema.safeParse(duplicate).success).toBe(false);

    const nonDaily = validPayload();
    (nonDaily["buckets"] as Array<Record<string, unknown>>)[0]!["bucketStart"] =
      "2026-07-18T01:00:00.000Z";
    expect(IngestSnapshotV2Schema.safeParse(nonDaily).success).toBe(false);
  });
});

describe("SupportedIngestSnapshotSchema", () => {
  it("accepts V1 and V2 while rejecting an unrecognized version", () => {
    expect(SupportedIngestSnapshotSchema.safeParse(validPayload()).success)
      .toBe(true);

    const v1 = validPayload();
    v1["schemaVersion"] = "1";
    v1["collector"] = {
      kind: "tokscale",
      adapterVersion: "0.1.0",
      sourceVersion: "4.5.2"
    };
    expect(SupportedIngestSnapshotSchema.safeParse(v1).success).toBe(true);

    const v3 = validPayload();
    v3["schemaVersion"] = "3";
    expect(SupportedIngestSnapshotSchema.safeParse(v3).success).toBe(false);
  });
});
