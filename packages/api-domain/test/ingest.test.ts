import { describe, expect, it } from "vitest";

import {
  ApiDomainError,
  enrollContributor,
  ingestSnapshot,
  type EnrollmentDependencies,
  type IngestDependencies
} from "../src/index.js";
import {
  AllowRateLimit,
  DeterministicIds,
  FixedClock,
  MemoryMutationStore,
  MockCredentialService,
  MutablePolicy,
  RATE_KEY,
  enrollmentBody,
  sidecarSnapshot,
  snapshot
} from "./helpers.js";

async function setup(): Promise<{
  dependencies: IngestDependencies;
  storage: MemoryMutationStore;
  policy: MutablePolicy;
  uploadToken: string;
  deletionToken: string;
}> {
  const clock = new FixedClock();
  const ids = new DeterministicIds();
  const credentials = new MockCredentialService();
  const policy = new MutablePolicy();
  const rateLimit = new AllowRateLimit();
  const storage = new MemoryMutationStore();
  const enrollmentDependencies: EnrollmentDependencies = {
    clock,
    ids,
    credentials,
    policy,
    rateLimit,
    storage
  };
  const enrollment = await enrollContributor(
    { body: enrollmentBody(), rateLimitKey: RATE_KEY },
    enrollmentDependencies
  );
  return {
    storage,
    policy,
    uploadToken: enrollment.credentials.uploadToken,
    deletionToken: enrollment.credentials.deletionToken,
    dependencies: {
      clock,
      credentials,
      policy,
      rateLimit,
      storage
    }
  };
}

async function expectCode(
  operation: Promise<unknown>,
  code: ApiDomainError["code"]
): Promise<ApiDomainError> {
  try {
    await operation;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ApiDomainError);
    expect((error as ApiDomainError).code).toBe(code);
    return error as ApiDomainError;
  }
  throw new Error("Expected ApiDomainError");
}

function command(uploadToken: string, body: unknown = snapshot()) {
  const batchId = (body as { batchId: string }).batchId;
  return {
    bearerToken: uploadToken,
    idempotencyKey: batchId,
    snapshot: body,
    rateLimitKey: RATE_KEY
  };
}

describe("authenticated V1 ingest", () => {
  it("atomically writes an absolute snapshot and replays the original receipt", async () => {
    const { dependencies, storage, uploadToken } = await setup();
    const first = await ingestSnapshot(command(uploadToken), dependencies);
    const replay = await ingestSnapshot(command(uploadToken), dependencies);

    expect(first).toMatchObject({
      replayed: false,
      status: "accepted",
      summary: {
        appliedBuckets: 1,
        staleBuckets: 0,
        idempotentBuckets: 0,
        quarantinedBuckets: 0
      }
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(storage.rows.size).toBe(1);
    expect(storage.authorities.size).toBe(1);
    expect(storage.batches.size).toBe(1);
    expect(storage.dirtyCount).toBe(1);
  });

  it("rejects reuse of a batch request key with different canonical content", async () => {
    const { dependencies, storage, uploadToken } = await setup();
    await ingestSnapshot(command(uploadToken), dependencies);
    const conflicting = snapshot({
      buckets: [
        {
          bucketStart: "2026-07-15T00:00:00.000Z",
          provider: "openai",
          modelFamily: "gpt-5",
          tool: "codex-cli",
          valueQuality: "exact",
          revision: 2,
          tokens: {
            input: "1201",
            output: "500",
            cacheRead: "800",
            cacheWrite: "0",
            reasoning: "120",
            other: "0",
            total: "2501"
          }
        }
      ]
    });
    await expectCode(
      ingestSnapshot(command(uploadToken, conflicting), dependencies),
      "BATCH_ID_REUSE"
    );
    expect(storage.rows.size).toBe(1);
    expect([...storage.rows.values()][0]?.revision).toBe(1);
  });

  it("handles higher, stale, and equal absolute revisions without additive totals", async () => {
    const { dependencies, storage, uploadToken } = await setup();
    const revision2 = snapshot({
      batchId: "f156f8ea-7924-49fa-9ad4-ec9e46565fb1",
      buckets: [
        {
          bucketStart: "2026-07-15T00:00:00.000Z",
          provider: "openai",
          modelFamily: "gpt-5",
          tool: "codex-cli",
          valueQuality: "exact",
          revision: 2,
          tokens: {
            input: "100",
            output: "50",
            cacheRead: "0",
            cacheWrite: "0",
            reasoning: "10",
            other: "0",
            total: "150"
          }
        }
      ]
    });
    await ingestSnapshot(command(uploadToken, revision2), dependencies);

    const stale = snapshot({
      batchId: "bf055c2a-8f78-4fb4-8cbe-e3c8c2d0e552"
    });
    const staleResult = await ingestSnapshot(
      command(uploadToken, stale),
      dependencies
    );
    expect(staleResult.summary.staleBuckets).toBe(1);
    expect([...storage.rows.values()][0]?.tokens.total).toBe("150");

    const equal = snapshot({
      batchId: "c6ba1d66-a559-4b9b-8ebd-1bf362870c97",
      buckets: (revision2 as { buckets: unknown[] }).buckets
    });
    const equalResult = await ingestSnapshot(
      command(uploadToken, equal),
      dependencies
    );
    expect(equalResult.summary.idempotentBuckets).toBe(1);
    expect(storage.dirtyCount).toBe(1);
  });

  it("rejects equal-revision mutation and a collector authority change for the same day", async () => {
    const { dependencies, storage, uploadToken } = await setup();
    await ingestSnapshot(command(uploadToken), dependencies);
    const revisionConflict = snapshot({
      batchId: "44f39ea5-2483-442e-aefa-f62d29378631",
      buckets: [
        {
          bucketStart: "2026-07-15T00:00:00.000Z",
          provider: "openai",
          modelFamily: "gpt-5",
          tool: "codex-cli",
          valueQuality: "exact",
          revision: 1,
          tokens: {
            input: "1",
            output: "0",
            cacheRead: "0",
            cacheWrite: "0",
            reasoning: "0",
            other: "0",
            total: "1"
          }
        }
      ]
    });
    await expectCode(
      ingestSnapshot(command(uploadToken, revisionConflict), dependencies),
      "REVISION_CONFLICT"
    );

    const authorityConflict = snapshot({
      batchId: "0f954ada-13e8-45ae-973b-c4d0bbaf8d03",
      collector: {
        kind: "tokentracker-bridge",
        adapterVersion: "0.1.0",
        sourceVersion: "0.79.8"
      }
    });
    await expectCode(
      ingestSnapshot(command(uploadToken, authorityConflict), dependencies),
      "AUTHORITY_CONFLICT"
    );
    expect(storage.rows.size).toBe(1);
    expect(storage.batches.size).toBe(1);
  });

  it("enforces credential scopes and invalid authentication", async () => {
    const { dependencies, deletionToken } = await setup();
    await expectCode(
      ingestSnapshot(command(deletionToken), dependencies),
      "TOKEN_INVALID"
    );
    await expectCode(
      ingestSnapshot(
        command(
          `tm_u1_${"Z".repeat(22)}.${"Q".repeat(43)}`
        ),
        dependencies
      ),
      "TOKEN_INVALID"
    );
  });

  it("rejects paused, deleting, and deleted installations", async () => {
    for (const [status, expected] of [
      ["paused", "INSTALLATION_PAUSED"],
      ["deleting", "INSTALLATION_DELETING"],
      ["deleted", "INSTALLATION_DELETED"]
    ] as const) {
      const { dependencies, storage, uploadToken } = await setup();
      storage.setStatus(status);
      await expectCode(
        ingestSnapshot(command(uploadToken), dependencies),
        expected
      );
    }
  });

  it("requires current consent, a supported collector, and a fresh UTC bucket", async () => {
    const staleConsent = await setup();
    staleConsent.policy.currentConsentDocumentRevision =
      "contribution-2026-07-16";
    await expectCode(
      ingestSnapshot(
        command(staleConsent.uploadToken),
        staleConsent.dependencies
      ),
      "CONSENT_REQUIRED"
    );

    const unsupported = await setup();
    const unsupportedBody = snapshot({
      collector: {
        kind: "tokscale",
        adapterVersion: "0.1.0",
        sourceVersion: "4.5.3"
      }
    });
    await expectCode(
      ingestSnapshot(
        command(unsupported.uploadToken, unsupportedBody),
        unsupported.dependencies
      ),
      "COLLECTOR_UNSUPPORTED"
    );

    const expired = await setup();
    const expiredBody = snapshot({
      buckets: [
        {
          bucketStart: "2026-06-15T00:00:00.000Z",
          provider: "openai",
          modelFamily: "gpt-5",
          tool: "codex-cli",
          valueQuality: "exact",
          revision: 1,
          tokens: {
            input: "1",
            output: "0",
            cacheRead: "0",
            cacheWrite: "0",
            reasoning: "0",
            other: "0",
            total: "1"
          }
        }
      ]
    });
    await expectCode(
      ingestSnapshot(
        command(expired.uploadToken, expiredBody),
        expired.dependencies
      ),
      "BUCKET_OUTSIDE_RETENTION"
    );
  });

  it("requires the Idempotency-Key header to exactly equal batchId", async () => {
    const { dependencies, uploadToken } = await setup();
    await expectCode(
      ingestSnapshot(
        {
          ...command(uploadToken),
          idempotencyKey: "f156f8ea-7924-49fa-9ad4-ec9e46565fb1"
        },
        dependencies
      ),
      "IDEMPOTENCY_KEY_MISMATCH"
    );
  });

  it("never leaks hasher canaries through errors or problem JSON", async () => {
    const setupResult = await setup();
    const canary = "prompt=CANARY_PRIVATE_CONTENT";
    const dependencies: IngestDependencies = {
      ...setupResult.dependencies,
      hasher: async () => {
        throw new Error(canary);
      }
    };
    const error = await expectCode(
      ingestSnapshot(command(setupResult.uploadToken), dependencies),
      "SERVICE_UNAVAILABLE"
    );
    expect(JSON.stringify(error)).not.toContain(canary);
    expect(JSON.stringify(error.toProblemDetails(canary))).not.toContain(
      canary
    );
  });
});

describe("authenticated V2 permanent-sidecar ingest", () => {
  it("applies and idempotently replays an exact supported sidecar snapshot", async () => {
    const { dependencies, storage, uploadToken } = await setup();
    const body = sidecarSnapshot();
    const first = await ingestSnapshot(command(uploadToken, body), dependencies);
    const replay = await ingestSnapshot(command(uploadToken, body), dependencies);

    expect(first).toMatchObject({
      replayed: false,
      status: "accepted",
      summary: { appliedBuckets: 1 }
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect([...storage.rows.values()][0]?.collector).toEqual({
      kind: "tokentracker-sidecar",
      adapterVersion: "0.1.0",
      sourceVersion: "0.80.0"
    });
    expect([...storage.authorities.values()][0]?.collectorKind).toBe(
      "tokentracker-sidecar"
    );
  });

  it("fails closed on an unsupported sidecar version or mismatched envelope", async () => {
    const unsupported = await setup();
    const wrongSource = sidecarSnapshot({
      collector: {
        kind: "tokentracker-sidecar",
        adapterVersion: "0.1.0",
        sourceVersion: "0.80.1"
      }
    });
    await expectCode(
      ingestSnapshot(
        command(unsupported.uploadToken, wrongSource),
        unsupported.dependencies
      ),
      "COLLECTOR_UNSUPPORTED"
    );

    const mismatched = await setup();
    const wrongKind = sidecarSnapshot({
      collector: {
        kind: "tokscale",
        adapterVersion: "0.1.0",
        sourceVersion: "4.5.2"
      }
    });
    await expectCode(
      ingestSnapshot(
        command(mismatched.uploadToken, wrongKind),
        mismatched.dependencies
      ),
      "SCHEMA_INVALID"
    );
  });
});
