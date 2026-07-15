import { describe, expect, it } from "vitest";
import {
  DeletionAcceptedResponseV1Schema,
  DeletionStatusResponseV1Schema
} from "@tokenmonster/contracts";

import {
  ApiDomainError,
  completeContributorDeletion,
  enrollContributor,
  getContributorDeletionStatus,
  ingestSnapshot,
  replayDeletionSuppressions,
  requestContributorDeletion,
  type DeletionDependencies,
  type EnrollmentDependencies,
  type IngestDependencies,
  type SuppressionLedgerPort
} from "../src/index.js";
import {
  AllowRateLimit,
  DELETE_KEY,
  DeterministicIds,
  FixedClock,
  MemoryMutationStore,
  MemorySuppressionLedger,
  MockCredentialService,
  MutablePolicy,
  RATE_KEY,
  enrollmentBody,
  snapshot
} from "./helpers.js";

async function setup(): Promise<{
  clock: FixedClock;
  storage: MemoryMutationStore;
  ledger: MemorySuppressionLedger;
  dependencies: DeletionDependencies;
  ingestDependencies: IngestDependencies;
  credentials: MockCredentialService;
  uploadToken: string;
  deletionToken: string;
}> {
  const clock = new FixedClock();
  const ids = new DeterministicIds();
  const credentials = new MockCredentialService();
  const policy = new MutablePolicy();
  const rateLimit = new AllowRateLimit();
  const storage = new MemoryMutationStore();
  const ledger = new MemorySuppressionLedger();
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
    clock,
    storage,
    ledger,
    credentials,
    uploadToken: enrollment.credentials.uploadToken,
    deletionToken: enrollment.credentials.deletionToken,
    dependencies: {
      clock,
      ids,
      credentials,
      rateLimit,
      storage,
      suppressionLedger: ledger
    },
    ingestDependencies: {
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

function deletionCommand(bearerToken: string, idempotencyKey = DELETE_KEY) {
  return {
    bearerToken,
    idempotencyKey,
    rateLimitKey: RATE_KEY
  };
}

function ingestCommand(uploadToken: string) {
  return {
    bearerToken: uploadToken,
    idempotencyKey: "6b0b8cb1-cd48-47ef-b676-c5a71d02a74b",
    snapshot: snapshot(),
    rateLimitKey: RATE_KEY
  };
}

describe("contributor deletion", () => {
  it("uses deletion scope, revokes upload atomically, and returns one status secret", async () => {
    const context = await setup();
    await ingestSnapshot(
      ingestCommand(context.uploadToken),
      context.ingestDependencies
    );
    const first = await requestContributorDeletion(
      deletionCommand(context.deletionToken),
      context.dependencies
    );

    expect(first).toMatchObject({
      status: "queued",
      anonymousHistoricalTotalsRetained: true
    });
    expect(first.jobId).toMatch(/^del_/);
    expect(first.statusToken).toMatch(/^tm_s1_/);
    const installation = [...context.storage.installations.values()][0];
    expect(installation?.status).toBe("deleting");
    expect(installation?.uploadCredential).toBeNull();
    await expectCode(
      ingestSnapshot(
        ingestCommand(context.uploadToken),
        context.ingestDependencies
      ),
      "TOKEN_INVALID"
    );

    const persisted = JSON.stringify({
      installations: [...context.storage.installations.values()],
      jobs: [...context.storage.jobs.values()]
    });
    expect(persisted).not.toContain(first.statusToken ?? "impossible");
    expect(persisted).toContain("hmacDigest");
    expect(context.ledger.entries.size).toBe(1);
  });

  it("does not let upload credentials delete or deletion credentials ingest", async () => {
    const context = await setup();
    await expectCode(
      requestContributorDeletion(
        deletionCommand(context.uploadToken),
        context.dependencies
      ),
      "TOKEN_INVALID"
    );
    await expectCode(
      ingestSnapshot(
        ingestCommand(context.deletionToken),
        context.ingestDependencies
      ),
      "TOKEN_INVALID"
    );
  });

  it("deterministically reissues a byte-identical contract response on replay", async () => {
    const context = await setup();
    const first = await requestContributorDeletion(
      deletionCommand(context.deletionToken),
      context.dependencies
    );
    const replay = await requestContributorDeletion(
      deletionCommand(context.deletionToken),
      context.dependencies
    );
    expect(DeletionAcceptedResponseV1Schema.safeParse(first).success).toBe(true);
    expect(DeletionAcceptedResponseV1Schema.safeParse(replay).success).toBe(
      true
    );
    expect(replay).toEqual(first);
    expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
    expect(context.storage.jobs.size).toBe(1);
    expect(context.ledger.entries.size).toBe(1);
  });

  it("purges identifiable hot state while retaining only replay/status HMAC receipts", async () => {
    const context = await setup();
    await ingestSnapshot(
      ingestCommand(context.uploadToken),
      context.ingestDependencies
    );
    const accepted = await requestContributorDeletion(
      deletionCommand(context.deletionToken),
      context.dependencies
    );
    const completed = await completeContributorDeletion(
      { jobId: accepted.jobId },
      { clock: context.clock, storage: context.storage }
    );

    expect(completed).toMatchObject({
      jobId: accepted.jobId,
      state: "complete",
      anonymousHistoricalTotalsRetained: true
    });
    expect(context.storage.rows.size).toBe(0);
    expect(context.storage.authorities.size).toBe(0);
    expect(context.storage.batches.size).toBe(0);
    expect(context.storage.consentReceipts.size).toBe(0);
    const installation = [...context.storage.installations.values()][0];
    expect(installation).toMatchObject({
      status: "deleted",
      uploadCredential: null,
      deletionCredential: null
    });

    const replay = await requestContributorDeletion(
      deletionCommand(context.deletionToken),
      context.dependencies
    );
    expect(replay).toEqual(accepted);
    await expectCode(
      requestContributorDeletion(
        deletionCommand(
          context.deletionToken,
          "different_delete_AAAAAAAA"
        ),
        context.dependencies
      ),
      "INSTALLATION_DELETED"
    );
  });

  it("allows a paused contributor to stop and delete", async () => {
    const context = await setup();
    context.storage.setStatus("paused");
    const result = await requestContributorDeletion(
      deletionCommand(context.deletionToken),
      context.dependencies
    );
    expect(result.status).toBe("queued");
  });

  it("fails closed if deterministic status credential artifacts drift", async () => {
    const context = await setup();
    await requestContributorDeletion(
      deletionCommand(context.deletionToken),
      context.dependencies
    );
    context.credentials.mismatchStatusOnReplay = true;
    await expectCode(
      requestContributorDeletion(
        deletionCommand(context.deletionToken),
        context.dependencies
      ),
      "CREDENTIAL_SERVICE_INVALID"
    );
    expect(context.storage.jobs.size).toBe(1);
  });

  it("replays the external suppression ledger after an old backup restore", async () => {
    const context = await setup();
    await ingestSnapshot(
      ingestCommand(context.uploadToken),
      context.ingestDependencies
    );
    const oldBackup = context.storage.backup();
    const accepted = await requestContributorDeletion(
      deletionCommand(context.deletionToken),
      context.dependencies
    );
    await completeContributorDeletion(
      { jobId: accepted.jobId },
      { clock: context.clock, storage: context.storage }
    );
    expect(context.storage.rows.size).toBe(0);

    context.storage.restore(oldBackup);
    expect(context.storage.rows.size).toBe(1);
    expect(context.storage.installations.size).toBe(1);
    const replay = await replayDeletionSuppressions({
      clock: context.clock,
      credentials: context.dependencies.credentials,
      storage: context.storage,
      suppressionLedger: context.ledger
    });
    expect(replay).toEqual({ examinedMarkers: 1, purgedInstallations: 1 });
    expect(context.storage.rows.size).toBe(0);
    expect(context.storage.installations.size).toBe(0);
  });

  it("sanitizes suppression-ledger failures and never echoes bearer canaries", async () => {
    const context = await setup();
    const canary = context.deletionToken;
    const failingLedger: SuppressionLedgerPort = {
      record: async () => {
        throw new Error(canary);
      },
      listActive: async () => []
    };
    const error = await expectCode(
      requestContributorDeletion(
        deletionCommand(context.deletionToken),
        { ...context.dependencies, suppressionLedger: failingLedger }
      ),
      "SERVICE_UNAVAILABLE"
    );
    expect(JSON.stringify(error)).not.toContain(canary);
    expect(JSON.stringify(error.toProblemDetails(canary))).not.toContain(
      canary
    );
    expect([...context.storage.installations.values()][0]?.status).toBe(
      "active"
    );
  });

  it("authenticates the job-scoped status credential before exposing lifecycle state", async () => {
    const context = await setup();
    const accepted = await requestContributorDeletion(
      deletionCommand(context.deletionToken),
      context.dependencies
    );
    const dependencies = {
      clock: context.clock,
      credentials: context.credentials,
      storage: context.storage
    };

    const queued = await getContributorDeletionStatus(
      { bearerToken: accepted.statusToken, jobId: accepted.jobId },
      dependencies
    );
    expect(DeletionStatusResponseV1Schema.parse(queued)).toEqual({
      contractVersion: 1,
      jobId: accepted.jobId,
      status: "queued",
      requestedAt: accepted.requestedAt,
      finishedAt: null,
      anonymousHistoricalTotalsRetained: true
    });
    expect(JSON.stringify(queued)).not.toContain(accepted.statusToken);
    expect(JSON.stringify(queued)).not.toContain("installationId");

    await completeContributorDeletion(
      { jobId: accepted.jobId },
      { clock: context.clock, storage: context.storage }
    );
    const completed = await getContributorDeletionStatus(
      { bearerToken: accepted.statusToken, jobId: accepted.jobId },
      dependencies
    );
    expect(completed).toMatchObject({
      status: "complete",
      finishedAt: context.clock.now().toISOString()
    });
  });

  it("does not allow status credentials to enumerate or cross job boundaries", async () => {
    const context = await setup();
    const accepted = await requestContributorDeletion(
      deletionCommand(context.deletionToken),
      context.dependencies
    );
    const dependencies = {
      clock: context.clock,
      credentials: context.credentials,
      storage: context.storage
    };
    const anotherJob = `del_Z${accepted.jobId.slice("del_".length + 1)}`;
    const firstRecord = context.storage.jobs.get(accepted.jobId);
    const anotherStatus = await context.credentials.issueDeletionStatus(
      anotherJob
    );
    if (firstRecord === undefined) throw new Error("missing deletion fixture");
    context.storage.jobs.set(
      anotherJob,
      Object.freeze({
        ...firstRecord,
        jobId: anotherJob,
        idempotencyKey: "another_delete_AAAAAAAA",
        statusCredential: anotherStatus.stored
      })
    );

    await expectCode(
      getContributorDeletionStatus(
        { bearerToken: accepted.statusToken, jobId: anotherJob },
        dependencies
      ),
      "TOKEN_INVALID"
    );
    await expectCode(
      getContributorDeletionStatus(
        { bearerToken: anotherStatus.bearerToken, jobId: accepted.jobId },
        dependencies
      ),
      "TOKEN_INVALID"
    );
    await expectCode(
      getContributorDeletionStatus(
        { bearerToken: context.deletionToken, jobId: accepted.jobId },
        dependencies
      ),
      "TOKEN_INVALID"
    );
    await expectCode(
      getContributorDeletionStatus(
        { bearerToken: accepted.statusToken, jobId: "not-a-job" },
        dependencies
      ),
      "SCHEMA_INVALID"
    );
  });

  it("expires status access and sanitizes storage failures", async () => {
    const context = await setup();
    const accepted = await requestContributorDeletion(
      deletionCommand(context.deletionToken),
      context.dependencies
    );
    const dependencies = {
      clock: context.clock,
      credentials: context.credentials,
      storage: context.storage
    };
    context.clock.value = new Date("2026-08-15T18:30:00.000Z");
    await expectCode(
      getContributorDeletionStatus(
        { bearerToken: accepted.statusToken, jobId: accepted.jobId },
        dependencies
      ),
      "TOKEN_INVALID"
    );

    context.clock.value = new Date("2026-07-15T18:30:00.000Z");
    const canary = `PRIVATE:${accepted.statusToken}`;
    const error = await expectCode(
      getContributorDeletionStatus(
        { bearerToken: accepted.statusToken, jobId: accepted.jobId },
        {
          ...dependencies,
          storage: {
            findCredentialCandidate: (...args) =>
              context.storage.findCredentialCandidate(...args),
            getDeletionJobStatus: async () => {
              throw new Error(canary);
            }
          }
        }
      ),
      "SERVICE_UNAVAILABLE"
    );
    expect(JSON.stringify(error)).not.toContain(canary);
    expect(JSON.stringify(error)).not.toContain(accepted.statusToken);
  });
});
