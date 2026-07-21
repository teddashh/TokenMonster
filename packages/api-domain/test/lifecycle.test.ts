import { beforeEach, describe, expect, it } from "vitest";

import {
  ApiDomainError,
  enrollContributor,
  ingestSnapshot,
  pauseContribution,
  resumeContribution,
  type ResumeDependencies
} from "../src/index.js";
import {
  AllowRateLimit,
  DeterministicIds,
  enrollmentBody,
  FixedClock,
  MemoryMutationStore,
  MockCredentialService,
  MutablePolicy,
  RATE_KEY,
  snapshot
} from "./helpers.js";

const ACKNOWLEDGED_AT = "2026-07-15T18:25:00.000Z";

function resumeBody(
  overrides: Readonly<Record<string, unknown>> = {}
): unknown {
  return {
    contractVersion: 1,
    consent: {
      purpose: "contribution",
      documentRevision: "contribution-2026-07-15",
      granted: true,
      acknowledgedAt: ACKNOWLEDGED_AT
    },
    ...overrides
  };
}

async function expectCode(
  operation: Promise<unknown>,
  code: ApiDomainError["code"]
): Promise<void> {
  try {
    await operation;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ApiDomainError);
    expect((error as ApiDomainError).code).toBe(code);
    return;
  }
  throw new Error("Expected ApiDomainError");
}

describe("contribution lifecycle", () => {
  let clock: FixedClock;
  let ids: DeterministicIds;
  let credentials: MockCredentialService;
  let policy: MutablePolicy;
  let rateLimit: AllowRateLimit;
  let storage: MemoryMutationStore;
  let uploadToken: string;
  let dependencies: ResumeDependencies;

  beforeEach(async () => {
    clock = new FixedClock();
    ids = new DeterministicIds();
    credentials = new MockCredentialService();
    policy = new MutablePolicy();
    rateLimit = new AllowRateLimit();
    storage = new MemoryMutationStore();
    const enrollment = await enrollContributor(
      { body: enrollmentBody(), rateLimitKey: RATE_KEY },
      { clock, ids, credentials, policy, rateLimit, storage }
    );
    uploadToken = enrollment.credentials.uploadToken;
    dependencies = { clock, ids, credentials, policy, rateLimit, storage };
    rateLimit.requests.length = 0;
  });

  it("pauses atomically, blocks ingest, and replays the original timestamp", async () => {
    const first = await pauseContribution(
      { bearerToken: uploadToken, rateLimitKey: RATE_KEY },
      dependencies
    );
    clock.value = new Date("2026-07-15T19:30:00.000Z");
    const replay = await pauseContribution(
      { bearerToken: uploadToken, rateLimitKey: RATE_KEY },
      dependencies
    );

    expect(first).toEqual({
      contractVersion: 1,
      status: "paused",
      pausedAt: "2026-07-15T18:30:00.000Z",
      futureUploadsBlocked: true,
      identifiableCurrentDataRetained: true,
      anonymousHistoricalTotalsRetained: true
    });
    expect(replay).toEqual(first);
    expect(rateLimit.requests.map(({ route }) => route)).toEqual([
      "lifecycle",
      "lifecycle"
    ]);
    await expectCode(
      ingestSnapshot(
        {
          bearerToken: uploadToken,
          idempotencyKey: "6b0b8cb1-cd48-47ef-b676-c5a71d02a74b",
          snapshot: snapshot(),
          rateLimitKey: RATE_KEY
        },
        { clock, credentials, policy, rateLimit, storage }
      ),
      "INSTALLATION_PAUSED"
    );
  });

  it("resumes with current affirmative consent and stores one immutable receipt", async () => {
    await pauseContribution(
      { bearerToken: uploadToken, rateLimitKey: RATE_KEY },
      dependencies
    );
    const receiptCount = storage.consentReceipts.size;
    const result = await resumeContribution(
      { bearerToken: uploadToken, body: resumeBody(), rateLimitKey: RATE_KEY },
      dependencies
    );
    const installation = [...storage.installations.values()][0];

    expect(result).toMatchObject({
      contractVersion: 1,
      status: "active",
      resumedAt: "2026-07-15T18:30:00.000Z",
      consentReceipt: {
        purpose: "contribution",
        documentRevision: "contribution-2026-07-15",
        granted: true,
        acknowledgedAt: ACKNOWLEDGED_AT,
        recordedAt: "2026-07-15T18:30:00.000Z"
      }
    });
    expect(storage.consentReceipts.size).toBe(receiptCount + 1);
    expect(installation).toMatchObject({ status: "active", pausedAt: null });

    const replay = await resumeContribution(
      { bearerToken: uploadToken, body: resumeBody(), rateLimitKey: RATE_KEY },
      dependencies
    );
    expect(replay).toEqual(result);
    expect(storage.consentReceipts.size).toBe(receiptCount + 1);
  });

  it("refreshes an active stale revision but rejects stale, revoked, future, and extra-field consent", async () => {
    policy.currentConsentDocumentRevision = "contribution-2026-07-16";
    const currentBody = {
      contractVersion: 1,
      consent: {
        purpose: "contribution",
        documentRevision: "contribution-2026-07-16",
        granted: true,
        acknowledgedAt: ACKNOWLEDGED_AT
      }
    };
    await expect(
      resumeContribution(
        { bearerToken: uploadToken, body: currentBody, rateLimitKey: RATE_KEY },
        dependencies
      )
    ).resolves.toMatchObject({
      status: "active",
      consentReceipt: { documentRevision: "contribution-2026-07-16" }
    });
    expect([...storage.installations.values()][0]).toMatchObject({
      status: "active",
      consentDocumentRevision: "contribution-2026-07-16"
    });

    for (const [body, code] of [
      [resumeBody(), "CONSENT_REQUIRED"],
      [
        {
          ...currentBody,
          consent: { ...currentBody.consent, granted: false }
        },
        "SCHEMA_INVALID"
      ],
      [
        {
          ...currentBody,
          consent: {
            ...currentBody.consent,
            acknowledgedAt: "2026-07-15T18:36:00.000Z"
          }
        },
        "ACKNOWLEDGEMENT_IN_FUTURE"
      ],
      [
        { ...currentBody, prompt: "must-not-cross-boundary" },
        "SCHEMA_INVALID"
      ]
    ] as const) {
      await expectCode(
        resumeContribution(
          { bearerToken: uploadToken, body, rateLimitKey: RATE_KEY },
          dependencies
        ),
        code
      );
    }
  });

  it("fails closed for wrong credential scope and terminal lifecycle states", async () => {
    const deletionToken = [...credentials.issuedByToken.entries()].find(
      ([, stored]) => stored.scope === "deletion"
    )?.[0];
    expect(deletionToken).toBeDefined();
    await expectCode(
      pauseContribution(
        { bearerToken: deletionToken!, rateLimitKey: RATE_KEY },
        dependencies
      ),
      "TOKEN_INVALID"
    );

    for (const [status, code] of [
      ["deleting", "INSTALLATION_DELETING"],
      ["deleted", "INSTALLATION_DELETED"]
    ] as const) {
      storage.setStatus(status);
      await expectCode(
        pauseContribution(
          { bearerToken: uploadToken, rateLimitKey: RATE_KEY },
          dependencies
        ),
        code
      );
    }
  });

  it("rolls back a failed state or consent mutation without partial writes", async () => {
    const original = storage.withLifecycleTransaction.bind(storage);
    storage.withLifecycleTransaction = async (installationId, operation) =>
      original(installationId, async (transaction) => {
        await operation(transaction);
        throw new Error("storage failure after lifecycle intent");
      });
    await expectCode(
      pauseContribution(
        { bearerToken: uploadToken, rateLimitKey: RATE_KEY },
        dependencies
      ),
      "SERVICE_UNAVAILABLE"
    );
    expect([...storage.installations.values()][0]?.status).toBe("active");
    expect(storage.consentReceipts.size).toBe(1);
  });
});
