import type {
  ProviderKindV1,
  SupportedCollectorKind
} from "@tokenmonster/contracts";

export function testUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

export interface TestBucketOptions {
  readonly bucketStart?: string;
  readonly provider?: ProviderKindV1;
  readonly modelFamily?: string;
  readonly tool?: string;
  readonly revision?: number;
  readonly input?: string;
  readonly output?: string;
  readonly cacheRead?: string;
  readonly cacheWrite?: string;
  readonly reasoning?: string;
  readonly other?: string;
}

export function testBucket(options: TestBucketOptions = {}) {
  const input = options.input ?? "100";
  const output = options.output ?? "20";
  const cacheRead = options.cacheRead ?? "10";
  const cacheWrite = options.cacheWrite ?? "5";
  const reasoning = options.reasoning ?? "4";
  const other = options.other ?? "1";
  const total = (
    BigInt(input) +
    BigInt(output) +
    BigInt(cacheRead) +
    BigInt(cacheWrite) +
    BigInt(other)
  ).toString();
  return {
    bucketStart: options.bucketStart ?? "2026-07-15T00:00:00.000Z",
    provider: options.provider ?? "anthropic",
    modelFamily: options.modelFamily ?? "claude-sonnet",
    tool: options.tool ?? "claude-code",
    valueQuality: "exact",
    revision: options.revision ?? 1,
    tokens: {
      input,
      output,
      cacheRead,
      cacheWrite,
      reasoning,
      other,
      total
    }
  };
}

export interface TestSnapshotOptions {
  readonly batchIndex?: number;
  readonly kind?: SupportedCollectorKind;
  readonly generatedAt?: string;
  readonly buckets?: readonly ReturnType<typeof testBucket>[];
}

export function testSnapshot(options: TestSnapshotOptions = {}) {
  const kind = options.kind ?? "tokscale";
  return {
    schemaVersion: kind === "tokentracker-sidecar" ? "2" : "1",
    batchId: testUuid(options.batchIndex ?? 1),
    generatedAt: options.generatedAt ?? "2026-07-15T12:00:00.000Z",
    collector: {
      kind,
      adapterVersion: "0.1.0",
      sourceVersion:
        kind === "tokscale"
          ? "4.5.2"
          : kind === "tokentracker-sidecar"
            ? "0.80.0"
            : "0.79.8"
    },
    buckets: options.buckets ?? [testBucket()]
  };
}

export function auth(enrollmentId = "enrollment-1") {
  return { enrollmentId };
}

export const RECEIVED_AT = "2026-07-15T12:01:00.000Z";
