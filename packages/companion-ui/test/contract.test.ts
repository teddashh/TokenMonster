import { describe, expect, it } from "vitest";

import {
  createUnavailableRetryBackoff,
  parseCompanionCollectorStatus,
  parseCompanionSnapshot,
  shouldAutomaticallyRetry,
  type CompanionHealthySnapshot
} from "../src/public/app.js";

const HEALTHY_RESPONSE = {
  status: "healthy",
  generatedAt: "2026-07-15T12:00:00.000Z",
  starter: {
    outcome: "selected",
    selectedBy: "unique-provider-total",
    characterId: "claude",
    providerFamily: "anthropic"
  },
  totals: {
    today: 30,
    last7Days: 50,
    last28Days: 60
  },
  daily: [
    { utcDate: "2026-06-18", totalTokens: 10 },
    { utcDate: "2026-07-10", totalTokens: 20 },
    { utcDate: "2026-07-15", totalTokens: 30 }
  ]
} as const;

describe("companion gateway response contract", () => {
  it("accepts an internally consistent 28-day aggregate without inventing days", () => {
    const parsed = parseCompanionSnapshot(HEALTHY_RESPONSE);

    expect(parsed).toEqual(HEALTHY_RESPONSE);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen((parsed as CompanionHealthySnapshot).daily)).toBe(true);
  });

  it("accepts a real zero-history state", () => {
    expect(
      parseCompanionSnapshot({
        status: "healthy",
        generatedAt: "2026-07-15T00:00:00Z",
        starter: {
          outcome: "user-choice-required",
          reason: "no-positive-provider-data",
          tiedProviderFamilies: []
        },
        totals: { today: 0, last7Days: 0, last28Days: 0 },
        daily: []
      })
    ).toMatchObject({ status: "healthy", totals: { last28Days: 0 } });
  });

  it.each(["sidecar-unavailable", "sidecar-incompatible"] as const)(
    "accepts the sanitized %s error",
    (error) => {
      expect(parseCompanionSnapshot({ status: "error", error })).toEqual({
        status: "error",
        error
      });
    }
  );

  it("caps unavailable retries and resets them after recovery or manual retry", () => {
    const backoff = createUnavailableRetryBackoff();

    expect([
      backoff.nextDelayMs(),
      backoff.nextDelayMs(),
      backoff.nextDelayMs(),
      backoff.nextDelayMs()
    ]).toEqual([5_000, 15_000, 60_000, 60_000]);
    backoff.reset();
    expect(backoff.nextDelayMs()).toBe(5_000);
  });

  it("automatically retries only transient unavailability", () => {
    expect(shouldAutomaticallyRetry("sidecar-unavailable")).toBe(true);
    expect(shouldAutomaticallyRetry("sidecar-incompatible")).toBe(false);
  });

  it.each([
    ["starting", null, 0, false],
    ["syncing", null, 0, false],
    ["ready", "2026-07-15T12:00:00.000Z", 0, true],
    ["ready-no-data", "2026-07-15T12:00:00.000Z", 0, true],
    ["refresh-failed", null, 1, true],
    ["stale", "2026-07-15T12:00:00.000Z", 2, true]
  ] as const)("accepts the content-blind %s collector phase", (
    phase,
    lastSuccessAt,
    consecutiveFailures,
    canRetry
  ) => {
    expect(
      parseCompanionCollectorStatus({
        phase,
        lastSuccessAt,
        consecutiveFailures,
        canRetry
      })
    ).toEqual({ phase, lastSuccessAt, consecutiveFailures, canRetry });
  });

  it.each([
    {
      phase: "ready",
      lastSuccessAt: null,
      consecutiveFailures: 0,
      canRetry: true
    },
    {
      phase: "refresh-failed",
      lastSuccessAt: null,
      consecutiveFailures: 0,
      canRetry: true
    },
    {
      phase: "stale",
      lastSuccessAt: "2026-07-15T12:00:00.000Z",
      consecutiveFailures: 1,
      canRetry: true,
      detail: "/private/path"
    }
  ])("rejects invalid or expanded collector snapshots", (value) => {
    expect(() => parseCompanionCollectorStatus(value)).toThrow(
      "Invalid collector response"
    );
  });

  it.each([
    ["an unknown field", { ...HEALTHY_RESPONSE, detail: "private detail" }],
    [
      "an inconsistent total",
      { ...HEALTHY_RESPONSE, totals: { ...HEALTHY_RESPONSE.totals, today: 31 } }
    ],
    [
      "an out-of-window day",
      {
        ...HEALTHY_RESPONSE,
        daily: [{ utcDate: "2026-06-17", totalTokens: 60 }]
      }
    ],
    [
      "unordered days",
      {
        ...HEALTHY_RESPONSE,
        daily: [...HEALTHY_RESPONSE.daily].reverse()
      }
    ],
    [
      "an unsafe count",
      {
        ...HEALTHY_RESPONSE,
        totals: {
          ...HEALTHY_RESPONSE.totals,
          last28Days: Number.MAX_SAFE_INTEGER + 1
        }
      }
    ],
    ["a raw error", { status: "error", error: "network-error" }],
    [
      "a mismatched starter provider",
      {
        ...HEALTHY_RESPONSE,
        starter: { ...HEALTHY_RESPONSE.starter, characterId: "grok" }
      }
    ],
    [
      "an invalid starter tie",
      {
        ...HEALTHY_RESPONSE,
        starter: {
          outcome: "user-choice-required",
          reason: "highest-provider-total-tie",
          tiedProviderFamilies: ["google"]
        }
      }
    ],
    [
      "an error detail",
      { status: "error", error: "sidecar-unavailable", detail: "/home/user" }
    ]
  ])("rejects %s", (_label, value) => {
    expect(() => parseCompanionSnapshot(value)).toThrow("Invalid companion response");
  });
});
