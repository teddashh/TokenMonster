import { describe, expect, it } from "vitest";

import {
  ApiDomainError,
  enrollContributor,
  type EnrollmentDependencies
} from "../src/index.js";
import {
  AllowRateLimit,
  DeterministicIds,
  FixedClock,
  MemoryMutationStore,
  MockCredentialService,
  MutablePolicy,
  RATE_KEY,
  enrollmentBody
} from "./helpers.js";

function setup(): {
  dependencies: EnrollmentDependencies;
  credentials: MockCredentialService;
  rateLimit: AllowRateLimit;
  storage: MemoryMutationStore;
  policy: MutablePolicy;
} {
  const credentials = new MockCredentialService();
  const rateLimit = new AllowRateLimit();
  const storage = new MemoryMutationStore();
  const policy = new MutablePolicy();
  return {
    credentials,
    rateLimit,
    storage,
    policy,
    dependencies: {
      clock: new FixedClock(),
      ids: new DeterministicIds(),
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

describe("contributor enrollment", () => {
  it("returns separate 256-bit upload/deletion secrets once and persists HMAC records only", async () => {
    const { dependencies, storage, rateLimit } = setup();
    const result = await enrollContributor(
      { body: enrollmentBody(), rateLimitKey: RATE_KEY },
      dependencies
    );

    expect(result.credentials.uploadToken).toMatch(/^tm_u1_/);
    expect(result.credentials.deletionToken).toMatch(/^tm_d1_/);
    expect(result.credentials.uploadToken).not.toBe(
      result.credentials.deletionToken
    );
    expect(result.consentReceipt).toMatchObject({
      receiptId: expect.stringMatching(/^cr_/),
      documentRevision: "contribution-2026-07-15",
      granted: true
    });
    expect(result.acceptedSnapshotSchemaVersions).toEqual(["1"]);

    const persisted = JSON.stringify({
      installations: [...storage.installations.values()],
      receipts: [...storage.consentReceipts.values()]
    });
    expect(persisted).not.toContain(result.credentials.uploadToken);
    expect(persisted).not.toContain(result.credentials.deletionToken);
    expect(persisted).not.toContain(
      result.credentials.uploadToken.split(".")[1]
    );
    expect(persisted).not.toContain(
      result.credentials.deletionToken.split(".")[1]
    );
    expect(persisted).toContain("hmacDigest");
    expect(rateLimit.requests).toEqual([
      {
        route: "enrollment",
        subjectKey: RATE_KEY,
        at: "2026-07-15T18:30:00.000Z"
      }
    ]);
    expect(JSON.stringify(rateLimit.requests)).not.toContain("tm_u1_");
  });

  it("rejects an explicit refusal and a stale consent revision", async () => {
    const first = setup();
    await expectCode(
      enrollContributor(
        {
          body: enrollmentBody({
            consent: {
              purpose: "contribution",
              documentRevision: "contribution-2026-07-15",
              granted: false,
              acknowledgedAt: "2026-07-15T18:20:00.000Z"
            }
          }),
          rateLimitKey: RATE_KEY
        },
        first.dependencies
      ),
      "CONSENT_NOT_GRANTED"
    );

    const second = setup();
    second.policy.currentConsentDocumentRevision =
      "contribution-2026-07-16";
    await expectCode(
      enrollContributor(
        { body: enrollmentBody(), rateLimitKey: RATE_KEY },
        second.dependencies
      ),
      "CONSENT_REQUIRED"
    );
    expect(second.storage.installations.size).toBe(0);
  });

  it("fails closed when credential issuance does not separate scopes", async () => {
    const { dependencies, credentials, storage } = setup();
    credentials.forceDuplicate = true;
    await expectCode(
      enrollContributor(
        { body: enrollmentBody(), rateLimitKey: RATE_KEY },
        dependencies
      ),
      "CREDENTIAL_SERVICE_INVALID"
    );
    expect(storage.installations.size).toBe(0);
  });

  it("sanitizes credential and storage failures without serializing canary secrets", async () => {
    const canary = "tm_u1_CANARY_SHOULD_NEVER_ESCAPE.secret";
    const first = setup();
    first.credentials.failWith = new Error(canary);
    const credentialError = await expectCode(
      enrollContributor(
        { body: enrollmentBody(), rateLimitKey: RATE_KEY },
        first.dependencies
      ),
      "SERVICE_UNAVAILABLE"
    );
    expect(JSON.stringify(credentialError)).not.toContain(canary);
    expect(
      JSON.stringify(credentialError.toProblemDetails(canary))
    ).not.toContain(canary);

    const second = setup();
    second.storage.failCreateWith = new Error(canary);
    const storageError = await expectCode(
      enrollContributor(
        { body: enrollmentBody(), rateLimitKey: RATE_KEY },
        second.dependencies
      ),
      "SERVICE_UNAVAILABLE"
    );
    expect(JSON.stringify(storageError)).not.toContain(canary);
    expect(second.storage.installations.size).toBe(0);
  });

  it("enforces rate limits before issuing any credential", async () => {
    const { dependencies, rateLimit, credentials } = setup();
    rateLimit.decision = Object.freeze({
      allowed: false,
      retryAfterSeconds: 70
    });
    const error = await expectCode(
      enrollContributor(
        { body: enrollmentBody(), rateLimitKey: RATE_KEY },
        dependencies
      ),
      "RATE_LIMITED"
    );
    expect(error.retryAfterSeconds).toBe(70);
    expect(credentials.issuedByToken.size).toBe(0);
  });
});
