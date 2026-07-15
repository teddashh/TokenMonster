import { describe, expect, it } from "vitest";

import {
  UsageDomainError,
  canonicalSerializeIngestBatch,
  canonicalSerializeServerRow,
  canonicalUsageKey,
  canonicalizeJson,
  hashIngestBatch,
  hashServerRow,
  parseStrictIngestSnapshot
} from "../src/index.js";
import { auth, testSnapshot } from "./helpers.js";

describe("canonical server serialization", () => {
  it("sorts object keys recursively while preserving array order", () => {
    expect(
      canonicalizeJson({ z: 1, a: { y: true, b: "two" }, list: [2, 1] })
    ).toBe('{"a":{"b":"two","y":true},"list":[2,1],"z":1}');
  });

  it("produces deterministic Web Crypto SHA-256 hashes", async () => {
    const snapshot = testSnapshot();
    const first = await hashIngestBatch(snapshot);
    const second = await hashIngestBatch(structuredClone(snapshot));

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });

  it("supports an injected canonical hasher without exposing client identity", async () => {
    const seen: string[] = [];
    const hash = await hashIngestBatch(testSnapshot(), (canonical) => {
      seen.push(canonical);
      return "ab".repeat(32);
    });

    expect(hash).toBe("ab".repeat(32));
    expect(seen).toEqual([canonicalSerializeIngestBatch(testSnapshot())]);
    expect(seen[0]).not.toContain("enrollmentId");
  });

  it("binds canonical row serialization and keys to authenticated enrollment", async () => {
    const snapshot = parseStrictIngestSnapshot(testSnapshot());
    const bucket = snapshot.buckets[0]!;
    const firstEnrollment = auth("server-enrollment-a");
    const secondEnrollment = auth("server-enrollment-b");
    const firstKey = canonicalUsageKey({
      ...firstEnrollment,
      bucketStart: bucket.bucketStart,
      provider: bucket.provider,
      modelFamily: bucket.modelFamily,
      tool: bucket.tool
    });
    const secondKey = canonicalUsageKey({
      ...secondEnrollment,
      bucketStart: bucket.bucketStart,
      provider: bucket.provider,
      modelFamily: bucket.modelFamily,
      tool: bucket.tool
    });

    expect(firstKey).not.toBe(secondKey);
    expect(
      canonicalSerializeServerRow(firstEnrollment, snapshot.collector, bucket)
    ).toContain("server-enrollment-a");
    expect(
      await hashServerRow(firstEnrollment, snapshot.collector, bucket)
    ).not.toBe(
      await hashServerRow(secondEnrollment, snapshot.collector, bucket)
    );
  });

  it("fails closed on unsupported JSON and invalid injected digests", async () => {
    expect(() => canonicalizeJson({ forbidden: undefined })).toThrowError(
      expect.objectContaining<Partial<UsageDomainError>>({
        code: "CANONICALIZATION_FAILED"
      })
    );
    await expect(
      hashIngestBatch(testSnapshot(), () => "not-a-sha256")
    ).rejects.toMatchObject({ code: "HASH_INVALID" });
  });
});
