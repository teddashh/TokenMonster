import { describe, expect, it } from "vitest";

import {
  UNAVAILABLE_COMPANION_CONTRIBUTION_STATUS,
  projectCompanionContributionStatus,
} from "../src/index.js";

function runtimeStatus(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    configured: true,
    secureStorage: "os-backed",
    state: "off",
    enabled: false,
    canEnable: true,
    canDelete: false,
    canRecover: false,
    outboxPending: 0,
    consentDocumentRevision: null,
    deletion: null,
    ...overrides,
  };
}

describe("companion contribution status projection", () => {
  it("publishes only the exact content-blind status DTO", () => {
    const response = projectCompanionContributionStatus(
      runtimeStatus({
        state: "active",
        enabled: true,
        canEnable: false,
        canDelete: true,
        outboxPending: 3,
        consentDocumentRevision: "contribution-2026-07-19",
      }),
    );

    expect(response).toEqual({
      status: "ok",
      availability: "available",
      unavailableReason: null,
      secureStorage: "os-backed",
      state: "active",
      enabled: true,
      canPreview: false,
      canStop: false,
      canDelete: false,
      canRecover: false,
      outboxPending: 3,
      deletionStatus: null,
      anonymousHistoricalTotalsRetained: null,
    });
    expect(Object.keys(response)).toEqual([
      "status",
      "availability",
      "unavailableReason",
      "secureStorage",
      "state",
      "enabled",
      "canPreview",
      "canStop",
      "canDelete",
      "canRecover",
      "outboxPending",
      "deletionStatus",
      "anonymousHistoricalTotalsRetained",
    ]);
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain("configured");
    expect(serialized).not.toContain("canEnable");
    expect(serialized).not.toContain("contribution-2026-07-19");
  });

  it("distinguishes available-but-off from consent or enrollment", () => {
    const response = projectCompanionContributionStatus(runtimeStatus());

    expect(response).toMatchObject({
      availability: "available",
      state: "off",
      enabled: false,
    });
    expect(response).not.toHaveProperty("configured");
    expect(response).not.toHaveProperty("enrollmentId");
  });

  it("exposes recovery only from the runtime's durable authority flag", () => {
    const recoverable = projectCompanionContributionStatus(
      runtimeStatus({
        state: "unavailable",
        canEnable: false,
        canRecover: true,
      }),
      true,
    );
    expect(recoverable).toMatchObject({
      availability: "unavailable",
      unavailableReason: "recovery-required",
      canRecover: true,
    });

    const unavailable = projectCompanionContributionStatus(
      runtimeStatus({ state: "unavailable", canEnable: false }),
      true,
    );
    expect(unavailable).toMatchObject({
      unavailableReason: "runtime-unavailable",
      canRecover: false,
    });
  });

  it("allows the runtime's deletion-complete state to prepare a fresh opt-in", () => {
    const response = projectCompanionContributionStatus(
      runtimeStatus({
        state: "deletion-complete",
        canEnable: true,
        deletion: {
          jobId: "del_abcdefghijklmnopqrstuv",
          status: "complete",
          requestedAt: "2026-07-19T12:00:00.000Z",
          finishedAt: "2026-07-19T12:01:00.000Z",
          anonymousHistoricalTotalsRetained: true,
        },
      }),
      true,
    );
    expect(response).toMatchObject({
      availability: "available",
      state: "deletion-complete",
      canPreview: true,
      canDelete: false,
      canRecover: false,
    });
  });

  it("projects durable cleanup recovery for active, stopped, and deletion-complete states", () => {
    const active = projectCompanionContributionStatus(
      runtimeStatus({
        state: "active",
        enabled: true,
        canEnable: false,
        canDelete: true,
        canRecover: true,
      }),
      true,
    );
    const stopped = projectCompanionContributionStatus(
      runtimeStatus({
        state: "stopped",
        canEnable: true,
        canDelete: true,
        canRecover: true,
      }),
      true,
    );
    const terminal = projectCompanionContributionStatus(
      runtimeStatus({
        state: "deletion-complete",
        canEnable: false,
        canRecover: true,
        deletion: {
          jobId: "del_abcdefghijklmnopqrstuv",
          status: "complete",
          requestedAt: "2026-07-19T12:00:00.000Z",
          finishedAt: "2026-07-19T12:01:00.000Z",
          anonymousHistoricalTotalsRetained: true,
        },
      }),
      true,
    );
    expect(active).toMatchObject({ state: "active", canRecover: true });
    expect(stopped).toMatchObject({ state: "stopped", canRecover: true });
    expect(terminal).toMatchObject({
      state: "deletion-complete",
      canPreview: false,
      canRecover: true,
    });
  });

  it("reduces deletion state to status and retention policy without opaque IDs", () => {
    const response = projectCompanionContributionStatus(
      runtimeStatus({
        state: "deletion-pending",
        canEnable: false,
        deletion: {
          jobId: "del_abcdefghijklmnopqrstuv",
          status: "running",
          requestedAt: "2026-07-19T12:00:00.000Z",
          finishedAt: null,
          anonymousHistoricalTotalsRetained: true,
        },
      }),
    );

    expect(response).toMatchObject({
      availability: "available",
      state: "deletion-pending",
      deletionStatus: "running",
      anonymousHistoricalTotalsRetained: true,
    });
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain("del_abcdefghijklmnopqrstuv");
    expect(serialized).not.toContain("2026-07-19T12:00:00.000Z");
  });

  it("fails closed for malformed, contradictory, inherited, extra-key, or accessor input", () => {
    let getterCalled = false;
    const accessor = runtimeStatus();
    Object.defineProperty(accessor, "configured", {
      enumerable: true,
      get: () => {
        getterCalled = true;
        return true;
      },
    });

    for (const input of [
      null,
      runtimeStatus({ enabled: true }),
      runtimeStatus({ secureStorage: "memory-only" }),
      runtimeStatus({ outboxPending: -1 }),
      runtimeStatus({ canRecover: true }),
      runtimeStatus({ canDelete: true }),
      runtimeStatus({
        state: "active",
        enabled: true,
        canEnable: true,
        canDelete: true,
      }),
      runtimeStatus({
        state: "active",
        enabled: true,
        canEnable: false,
        canDelete: false,
      }),
      { ...runtimeStatus(), uploadCredential: "tm_u1_SECRET_CANARY" },
      Object.assign(Object.create({ inherited: true }), runtimeStatus()),
      accessor,
    ]) {
      expect(projectCompanionContributionStatus(input)).toBe(
        UNAVAILABLE_COMPANION_CONTRIBUTION_STATUS,
      );
    }
    expect(getterCalled).toBe(false);
  });

  it("fails closed when deletion state, terminal time, or status disagree", () => {
    const deletion = {
      jobId: "del_abcdefghijklmnopqrstuv",
      status: "running",
      requestedAt: "2026-07-19T12:00:00.000Z",
      finishedAt: null,
      anonymousHistoricalTotalsRetained: true,
    };
    for (const input of [
      runtimeStatus({ state: "off", deletion }),
      runtimeStatus({
        state: "deletion-complete",
        canEnable: false,
        deletion,
      }),
      runtimeStatus({
        state: "deletion-pending",
        canEnable: false,
        deletion: { ...deletion, finishedAt: "2026-07-19T12:01:00.000Z" },
      }),
    ]) {
      expect(projectCompanionContributionStatus(input)).toBe(
        UNAVAILABLE_COMPANION_CONTRIBUTION_STATUS,
      );
    }
  });
});
