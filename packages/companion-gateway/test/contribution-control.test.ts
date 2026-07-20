import { describe, expect, it, vi } from "vitest";

import {
  CONTRIBUTION_CONSENT_SUMMARY_MAX_LENGTH,
  CONTRIBUTION_CONSENT_TITLE_MAX_LENGTH,
  CONTRIBUTION_FIELD_ALLOWLIST,
  CONTRIBUTION_RETENTION_DISCLOSURE_MAX_LENGTH,
  type ContributionRuntimeStatus,
} from "@tokenmonster/contribution-runtime";

import {
  prepareCompanionContributionPreview,
  projectCompanionContributionPreview,
  runCompanionContributionAction,
  type CompanionContributionController,
} from "../src/index.js";

const PREVIEW_ID = "10000000-0000-4000-8000-000000000001";
const FORBIDDEN = Object.freeze([
  "prompt / response / message content",
  "source code / filename / project path",
  "API key / OAuth token / provider credential",
  "raw log / event / session / hourly bucket",
]);

function status(
  overrides: Partial<ContributionRuntimeStatus> = {},
): ContributionRuntimeStatus {
  return Object.freeze({
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
  });
}

function preview() {
  return Object.freeze({
    previewId: PREVIEW_ID,
    expiresAt: "2026-07-19T12:10:00.000Z",
    document: Object.freeze({
      revision: "contribution-2026-07-19",
      title: "自願分享匿名 Token 日彙總",
      summary: "只分享內容盲 UTC 日彙總。",
      retentionDisclosure: "目前可識別日彙總最多保留 30 天。",
    }),
    fieldAllowlist: CONTRIBUTION_FIELD_ALLOWLIST,
    forbidden: FORBIDDEN,
    payload: null,
    eligibleBucketCount: 0,
    remainingEligibleBucketCount: 0,
  });
}

function controller(
  overrides: Partial<CompanionContributionController> = {},
): CompanionContributionController {
  const defaults: CompanionContributionController = {
    status: () => status(),
    preparePreview: async () => preview(),
    enable: async () => ({ ok: true, code: "enabled" as const, status: status() }),
    stop: async () => ({ ok: true, code: "stopped" as const, status: status() }),
    requestDeletion: async () => ({
      ok: true,
      code: "deletion-requested" as const,
      status: status(),
    }),
    recover: async () => ({
      ok: true,
      code: "deletion-status-updated" as const,
      status: status(),
    }),
  };
  return Object.freeze({ ...defaults, ...overrides });
}

describe("companion contribution control projection", () => {
  it("projects the exact bounded preview and no credential authority", () => {
    const projected = projectCompanionContributionPreview(preview());
    expect(projected).toEqual({ status: "ok", preview: preview() });
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain("tm_u");
    expect(serialized).not.toContain("tm_d");
    expect(serialized).not.toContain("tm_r");
    expect(serialized).not.toContain("/home/");
  });

  it("rejects extra fields and accessors without evaluating them", () => {
    expect(
      projectCompanionContributionPreview({ ...preview(), apiBaseUrl: "CANARY" }),
    ).toBeNull();
    let getterCalled = false;
    const accessor = { ...preview() } as Record<string, unknown>;
    Object.defineProperty(accessor, "payload", {
      enumerable: true,
      get: () => {
        getterCalled = true;
        return null;
      },
    });
    expect(projectCompanionContributionPreview(accessor)).toBeNull();
    expect(getterCalled).toBe(false);
  });

  it("uses the exact runtime safe-text limits for projected consent copy", () => {
    for (const disclosureLength of [2_049, 4_000]) {
      const candidate = {
        ...preview(),
        document: {
          ...preview().document,
          title: "T".repeat(CONTRIBUTION_CONSENT_TITLE_MAX_LENGTH),
          summary: "S".repeat(CONTRIBUTION_CONSENT_SUMMARY_MAX_LENGTH),
          retentionDisclosure: "R".repeat(disclosureLength),
        },
      };
      expect(projectCompanionContributionPreview(candidate)).not.toBeNull();
    }
    for (const document of [
      { ...preview().document, title: "T".repeat(201) },
      { ...preview().document, summary: "S".repeat(2_001) },
      {
        ...preview().document,
        retentionDisclosure: "R".repeat(
          CONTRIBUTION_RETENTION_DISCLOSURE_MAX_LENGTH + 1,
        ),
      },
      { ...preview().document, summary: "unsafe\u001fsummary" },
    ]) {
      expect(
        projectCompanionContributionPreview({ ...preview(), document }),
      ).toBeNull();
    }
  });

  it("sanitizes thrown preview errors", async () => {
    const errorCanary = "tm_u2_ENDPOINT_TOKEN_ERROR_CANARY";
    const response = await prepareCompanionContributionPreview(
      controller({
        preparePreview: vi.fn(async () => {
          throw new Error(errorCanary);
        }),
      }),
    );
    expect(response).toMatchObject({
      status: "error",
      action: "preview",
      code: "local-service-error",
    });
    expect(JSON.stringify(response)).not.toContain(errorCanary);
  });

  it("binds each action to its exact success codes", async () => {
    for (const [action, substitutedCode] of [
      ["enable", "deletion-requested"],
      ["stop", "enabled"],
      ["delete", "stopped"],
      ["recover", "uploaded"],
    ] as const) {
      const response = await runCompanionContributionAction(
        controller(),
        action,
        async () => ({ ok: true, code: substitutedCode, status: status() }),
      );
      expect(response).toMatchObject({
        status: "error",
        action,
        code: "contract-mismatch",
      });
    }
  });

  it("rejects success/error polarity swaps and malformed result status", async () => {
    const polarity = await runCompanionContributionAction(
      controller(),
      "enable",
      async () => ({ ok: false, code: "enabled", status: status() }),
    );
    expect(polarity).toMatchObject({ status: "error", code: "contract-mismatch" });

    const malformed = await runCompanionContributionAction(
      controller(),
      "enable",
      async () => ({
        ok: true,
        code: "enabled",
        status: { ...status(), uploadToken: "tm_u2_CANARY" },
      }),
    );
    expect(malformed).toMatchObject({ status: "error", code: "contract-mismatch" });
    expect(JSON.stringify(malformed)).not.toContain("tm_u2_CANARY");

    const impossibleSuccess = await runCompanionContributionAction(
      controller(),
      "enable",
      async () => ({ ok: true, code: "enabled", status: status() }),
    );
    expect(impossibleSuccess).toMatchObject({
      status: "error",
      code: "contract-mismatch",
    });

    for (const [action, code, resultStatus] of [
      ["stop", "stopped", status()],
      [
        "stop",
        "pause-pending",
        status({
          state: "deletion-pending",
          canEnable: false,
          deletion: {
            jobId: "del_abcdefghijklmnopqrstuv",
            status: "queued",
            requestedAt: "2026-07-19T12:00:00.000Z",
            finishedAt: null,
            anonymousHistoricalTotalsRetained: true,
          },
        }),
      ],
    ] as const) {
      const response = await runCompanionContributionAction(
        controller(),
        action,
        async () => ({ ok: true, code, status: resultStatus }),
      );
      expect(response).toMatchObject({
        status: "error",
        code: "contract-mismatch",
      });
    }

    const recoveredStopped = await runCompanionContributionAction(
      controller(),
      "recover",
      async () => ({
        ok: true,
        code: "stopped",
        status: status({
          state: "stopped",
          canEnable: true,
          canDelete: true,
        }),
      }),
    );
    expect(recoveredStopped).toMatchObject({
      status: "ok",
      action: "recover",
      code: "stopped",
      contribution: { state: "stopped", canRecover: false },
    });
  });

  it("returns the strictly projected action snapshot without racing a later status read", async () => {
    const statusSpy = vi.fn(() => {
      throw new Error("LATER_STATUS_RACE_CANARY");
    });
    const source = controller({ status: statusSpy });
    const resultStatus = status({
      state: "active",
      enabled: true,
      canEnable: false,
      canDelete: true,
      consentDocumentRevision: "contribution-2026-07-19",
    });
    const response = await runCompanionContributionAction(
      source,
      "enable",
      async () => ({ ok: true, code: "enabled", status: resultStatus }),
    );
    expect(response).toMatchObject({
      status: "ok",
      contribution: { state: "active", canStop: true, canDelete: true },
    });
    expect(statusSpy).not.toHaveBeenCalled();
  });
});
