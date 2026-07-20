import { describe, expect, it } from "vitest";

import {
  ApiDomainError,
  enrollContributorRecoverably,
  type RecoverableEnrollmentDependencies
} from "../src/index.js";
import {
  AllowRateLimit,
  DeterministicIds,
  FixedClock,
  MemoryMutationStore,
  MockCredentialService,
  MutablePolicy,
  RATE_KEY
} from "./helpers.js";

const NOW = "2026-07-15T18:30:00.000Z";
const credentials = Object.freeze({
  uploadToken: `tm_u2_${"u".repeat(24)}.${"U".repeat(43)}`,
  deletionToken: `tm_d2_${"d".repeat(24)}.${"D".repeat(42)}E`,
  recoveryToken: `tm_r2_${"r".repeat(24)}.${"R".repeat(42)}I`
});

function body(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    contractVersion: 2,
    credentials,
    consent: {
      purpose: "contribution",
      documentRevision: "contribution-2026-07-15",
      granted: true,
      acknowledgedAt: NOW
    },
    ...overrides
  };
}

function setup(): {
  dependencies: RecoverableEnrollmentDependencies;
  clock: FixedClock;
  credentials: MockCredentialService;
  policy: MutablePolicy;
  rateLimit: AllowRateLimit;
  storage: MemoryMutationStore;
} {
  const clock = new FixedClock();
  const credentialService = new MockCredentialService();
  const policy = new MutablePolicy();
  const rateLimit = new AllowRateLimit();
  const storage = new MemoryMutationStore();
  return {
    clock,
    credentials: credentialService,
    policy,
    rateLimit,
    storage,
    dependencies: {
      clock,
      ids: new DeterministicIds(),
      credentials: credentialService,
      policy,
      rateLimit,
      storage
    }
  };
}

async function expectCode(
  operation: Promise<unknown>,
  code: ApiDomainError["code"]
): Promise<void> {
  await expect(operation).rejects.toMatchObject({ name: "ApiDomainError", code });
}

describe("recoverable contributor enrollment", () => {
  it("stores only verifier material and returns no credential or installation id", async () => {
    const context = setup();
    const result = await enrollContributorRecoverably(
      { body: body(), rateLimitKey: RATE_KEY },
      context.dependencies
    );

    expect(result).toMatchObject({
      contractVersion: 2,
      status: "active",
      acceptedSnapshotSchemaVersions: ["1", "2"]
    });
    expect(JSON.stringify(result)).not.toMatch(/tm_[udr]2_|installation/i);
    const persisted = JSON.stringify({
      installations: [...context.storage.installations.values()],
      receipts: [...context.storage.consentReceipts.values()],
      recoveries: [...context.storage.recoverableEnrollments.values()]
    });
    for (const bearer of Object.values(credentials)) {
      expect(persisted).not.toContain(bearer);
      expect(persisted).not.toContain(bearer.split(".")[1]);
    }
    expect(persisted).toContain("hmacDigest");
  });

  it("recovers the original receipt after time and policy advance", async () => {
    const context = setup();
    const first = await enrollContributorRecoverably(
      { body: body(), rateLimitKey: RATE_KEY },
      context.dependencies
    );
    context.clock.value = new Date("2026-07-20T18:30:00.000Z");
    context.policy.currentConsentDocumentRevision =
      "contribution-2026-07-20";

    const replay = await enrollContributorRecoverably(
      { body: body(), rateLimitKey: RATE_KEY },
      context.dependencies
    );
    expect(replay).toEqual(first);
    expect(context.storage.installations.size).toBe(1);
    expect(context.storage.consentReceipts.size).toBe(1);
  });

  it("recovers when storage commits but its acknowledgement is lost", async () => {
    const context = setup();
    const original = context.storage.createRecoverableEnrollmentAtomically.bind(
      context.storage
    );
    context.storage.createRecoverableEnrollmentAtomically = async (input) => {
      await original(input);
      throw new Error("COMMIT_ACK_LOST");
    };

    const result = await enrollContributorRecoverably(
      { body: body(), rateLimitKey: RATE_KEY },
      context.dependencies
    );
    expect(result).toMatchObject({ contractVersion: 2, status: "active" });
    expect(context.storage.installations.size).toBe(1);
  });

  it("makes concurrent exact attempts converge on one enrollment", async () => {
    const context = setup();
    const [first, second] = await Promise.all([
      enrollContributorRecoverably(
        { body: body(), rateLimitKey: RATE_KEY },
        context.dependencies
      ),
      enrollContributorRecoverably(
        { body: body(), rateLimitKey: RATE_KEY },
        context.dependencies
      )
    ]);
    expect(second).toEqual(first);
    expect(context.storage.installations.size).toBe(1);
    expect(context.storage.recoverableEnrollments.size).toBe(1);
  });

  it("rejects any credential or accepted-consent drift on recovery", async () => {
    const context = setup();
    await enrollContributorRecoverably(
      { body: body(), rateLimitKey: RATE_KEY },
      context.dependencies
    );
    for (const changed of [
      {
        uploadToken: `tm_u2_${"u".repeat(24)}.${"X".repeat(42)}E`
      },
      {
        deletionToken: `tm_d2_${"d".repeat(24)}.${"Y".repeat(42)}I`
      },
      {
        recoveryToken: `tm_r2_${"r".repeat(24)}.${"Z".repeat(42)}Q`
      }
    ]) {
      await expectCode(
        enrollContributorRecoverably(
          {
            body: body({ credentials: { ...credentials, ...changed } }),
            rateLimitKey: RATE_KEY
          },
          context.dependencies
        ),
        "TOKEN_INVALID"
      );
    }
    await expectCode(
      enrollContributorRecoverably(
        {
          body: body({
            consent: {
              purpose: "contribution",
              documentRevision: "contribution-2026-07-15",
              granted: true,
              acknowledgedAt: "2026-07-15T18:29:59.000Z"
            }
          }),
          rateLimitKey: RATE_KEY
        },
        context.dependencies
      ),
      "TOKEN_INVALID"
    );
    expect(context.storage.installations.size).toBe(1);
  });

  it("applies current consent and freshness checks only to first creation", async () => {
    const stale = setup();
    stale.policy.currentConsentDocumentRevision =
      "contribution-2026-07-16";
    await expectCode(
      enrollContributorRecoverably(
        { body: body(), rateLimitKey: RATE_KEY },
        stale.dependencies
      ),
      "CONSENT_REQUIRED"
    );
    expect(stale.storage.installations.size).toBe(0);

    const future = setup();
    await expectCode(
      enrollContributorRecoverably(
        {
          body: body({
            consent: {
              purpose: "contribution",
              documentRevision: "contribution-2026-07-15",
              granted: true,
              acknowledgedAt: "2026-07-15T18:36:00.000Z"
            }
          }),
          rateLimitKey: RATE_KEY
        },
        future.dependencies
      ),
      "ACKNOWLEDGEMENT_IN_FUTURE"
    );
    expect(future.storage.installations.size).toBe(0);

    const expired = setup();
    await expectCode(
      enrollContributorRecoverably(
        {
          body: body({
            consent: {
              purpose: "contribution",
              documentRevision: "contribution-2026-07-15",
              granted: true,
              acknowledgedAt: "2026-07-15T18:20:00.000Z"
            }
          }),
          rateLimitKey: RATE_KEY
        },
        expired.dependencies
      ),
      "ACKNOWLEDGEMENT_EXPIRED"
    );
    expect(expired.storage.installations.size).toBe(0);
  });
});
