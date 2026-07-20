import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONTRIBUTION_CONSENT_SUMMARY_MAX_LENGTH,
  CONTRIBUTION_CONSENT_TITLE_MAX_LENGTH,
  CONTRIBUTION_DELETE_ENDPOINT,
  CONTRIBUTION_ENABLE_ENDPOINT,
  CONTRIBUTION_PREVIEW_ENDPOINT,
  CONTRIBUTION_RETENTION_DISCLOSURE_MAX_LENGTH,
  CONTRIBUTION_STATUS_ENDPOINT,
  contributionActionAttemptSucceeded,
  contributionControlView,
  parseContributionAction,
  parseContributionPreview,
  parseContributionStatus,
  requestContributionAction,
  requestContributionActionWithStatusRecovery,
  requestContributionPreview,
  requestContributionStatus,
  retainContributionPreview,
} from "../src/public/contribution-control.js";
import { setUiLocale } from "../src/public/localization.js";

const PREVIEW_ID = "10000000-0000-4000-8000-000000000001";

function unavailableStatus() {
  return {
    status: "ok",
    availability: "unavailable",
    unavailableReason: "secure-storage-unavailable",
    secureStorage: "unavailable",
    state: "unavailable",
    enabled: false,
    canPreview: false,
    canStop: false,
    canDelete: false,
    canRecover: false,
    outboxPending: 0,
    deletionStatus: null,
    anonymousHistoricalTotalsRetained: null,
  };
}

function activeStatus() {
  return {
    status: "ok",
    availability: "available",
    unavailableReason: null,
    secureStorage: "os-backed",
    state: "active",
    enabled: true,
    canPreview: false,
    canStop: true,
    canDelete: true,
    canRecover: false,
    outboxPending: 0,
    deletionStatus: null,
    anonymousHistoricalTotalsRetained: null,
  };
}

function preview(payload: unknown = null) {
  return {
    previewId: PREVIEW_ID,
    expiresAt: "2026-07-19T12:10:00.000Z",
    document: {
      revision: "contribution-2026-07-19",
      title: "自願分享匿名 Token 日彙總",
      summary: "只分享內容盲 UTC 日彙總。",
      retentionDisclosure: "目前可識別日彙總最多保留 30 天。",
    },
    fieldAllowlist: [
      "schemaVersion",
      "batchId",
      "generatedAt",
      "collector.kind",
      "collector.adapterVersion",
      "collector.sourceVersion",
      "buckets.bucketStart",
      "buckets.provider",
      "buckets.modelFamily",
      "buckets.tool",
      "buckets.valueQuality",
      "buckets.revision",
      "buckets.tokens.input",
      "buckets.tokens.output",
      "buckets.tokens.cacheRead",
      "buckets.tokens.cacheWrite",
      "buckets.tokens.reasoning",
      "buckets.tokens.other",
      "buckets.tokens.total",
    ],
    forbidden: [
      "prompt / response / message content",
      "source code / filename / project path",
      "API key / OAuth token / provider credential",
      "raw log / event / session / hourly bucket",
    ],
    payload,
    eligibleBucketCount:
      typeof payload === "object" && payload !== null ? 1 : 0,
    remainingEligibleBucketCount: 0,
  };
}

function response(body: unknown, status = 200): Response {
  const serialized = JSON.stringify(body);
  return new Response(serialized, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(new TextEncoder().encode(serialized).byteLength),
    },
  });
}

afterEach(() => {
  setUiLocale("zh-TW");
  vi.restoreAllMocks();
});

describe("anonymous contribution browser control", () => {
  it("strictly parses the canonical default-off secure-storage state", () => {
    const parsed = parseContributionStatus(unavailableStatus());
    expect(contributionControlView(parsed)).toMatchObject({
      statusText:
        "匿名貢獻無法啟用：這個啟動方式沒有經稽核的作業系統安全儲存。",
      canPreview: false,
      canStop: false,
      canDelete: false,
      canRecover: false,
    });
    setUiLocale("en");
    expect(contributionControlView(parsed).statusText).not.toMatch(
      /\p{Script=Han}/u,
    );
  });

  it("accepts durable cleanup recovery in active, stopped, and terminal deletion states", () => {
    for (const candidate of [
      { ...activeStatus(), canRecover: true },
      {
        ...activeStatus(),
        state: "stopped",
        enabled: false,
        canPreview: true,
        canStop: false,
        canDelete: true,
        canRecover: true,
      },
      {
        ...activeStatus(),
        state: "deletion-complete",
        enabled: false,
        canPreview: false,
        canStop: false,
        canDelete: false,
        canRecover: true,
        deletionStatus: "complete",
        anonymousHistoricalTotalsRetained: true,
      },
    ]) {
      expect(
        contributionControlView(parseContributionStatus(candidate)),
      ).toMatchObject({
        canRecover: true,
        statusText: "上次操作仍需安全完成本機憑證清理；復原不會建立新憑證。",
      });
    }

    const failed = parseContributionStatus({
      ...activeStatus(),
      state: "deletion-failed",
      enabled: false,
      canStop: false,
      canDelete: false,
      deletionStatus: "failed",
      anonymousHistoricalTotalsRetained: true,
    });
    expect(contributionControlView(failed).statusText).toBe(
      "刪除狀態失敗；後續上傳仍停用，請聯絡支援。",
    );
  });

  it("never keeps an old confirmed preview actionable after controls turn off", () => {
    const prepared = parseContributionPreview(preview());
    const active = parseContributionStatus(activeStatus());
    expect(retainContributionPreview(active, prepared)).toBeNull();
    const off = parseContributionStatus({
      ...activeStatus(),
      state: "off",
      enabled: false,
      canPreview: true,
      canStop: false,
      canDelete: false,
    });
    expect(retainContributionPreview(off, prepared)).toBe(prepared);
    const stopped = parseContributionStatus({
      ...activeStatus(),
      state: "stopped",
      enabled: false,
      canPreview: true,
      canStop: false,
      canDelete: true,
    });
    expect(retainContributionPreview(stopped, prepared, true)).toBeNull();
  });

  it("uses the exact runtime consent text bounds including the 4,000-character disclosure", () => {
    for (const disclosureLength of [2_049, 4_000]) {
      expect(
        parseContributionPreview({
          ...preview(),
          document: {
            ...preview().document,
            title: "T".repeat(CONTRIBUTION_CONSENT_TITLE_MAX_LENGTH),
            summary: "S".repeat(CONTRIBUTION_CONSENT_SUMMARY_MAX_LENGTH),
            retentionDisclosure: "R".repeat(disclosureLength),
          },
        }).document.retentionDisclosure,
      ).toHaveLength(disclosureLength);
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
      { ...preview().document, title: "unsafe\u0000title" },
    ]) {
      expect(() =>
        parseContributionPreview({ ...preview(), document }),
      ).toThrow("Invalid contribution preview");
    }
  });

  it("rejects extra keys and accessors without exposing a token canary", () => {
    expect(() =>
      parseContributionStatus({
        ...unavailableStatus(),
        uploadToken: "tm_u2_CANARY",
      }),
    ).toThrow("Invalid contribution status");
    let getterCalled = false;
    const accessor = unavailableStatus();
    Object.defineProperty(accessor, "outboxPending", {
      enumerable: true,
      get: () => {
        getterCalled = true;
        return 0;
      },
    });
    expect(() => parseContributionStatus(accessor)).toThrow();
    expect(getterCalled).toBe(false);
  });

  it("accepts only the reviewed content-blind payload shape", () => {
    const payload = {
      schemaVersion: "2",
      batchId: "10000000-0000-4000-8000-000000000002",
      generatedAt: "2026-07-19T12:00:00.000Z",
      collector: {
        kind: "tokentracker-sidecar",
        adapterVersion: "0.1.0",
        sourceVersion: "0.80.0",
      },
      buckets: [
        {
          bucketStart: "2026-07-18T00:00:00.000Z",
          provider: "other",
          modelFamily: "all",
          tool: "all",
          valueQuality: "exact",
          revision: 1,
          tokens: {
            input: "2",
            output: "3",
            cacheRead: "4",
            cacheWrite: "0",
            reasoning: "1",
            other: "0",
            total: "9",
          },
        },
      ],
    };
    expect(parseContributionPreview(preview(payload)).payload).toEqual(payload);
    expect(() =>
      parseContributionPreview(
        preview({ ...payload, prompt: "SECRET_PROMPT_CANARY" }),
      ),
    ).toThrow("Invalid contribution preview");
    expect(() =>
      parseContributionPreview({
        ...preview(),
        document: {
          ...preview().document,
          revision: "contribution-2026-99-99",
        },
      }),
    ).toThrow("Invalid contribution preview");
    expect(() =>
      parseContributionPreview({
        ...preview(),
        forbidden: ["credentials are allowed"],
      }),
    ).toThrow("Invalid contribution preview");
  });

  it("rejects action/code/status substitutions", () => {
    expect(
      parseContributionAction({
        status: "ok",
        action: "enable",
        code: "enabled",
        contribution: activeStatus(),
      }),
    ).toMatchObject({ status: "ok", action: "enable", code: "enabled" });
    for (const candidate of [
      {
        status: "ok",
        action: "enable",
        code: "deletion-requested",
        contribution: activeStatus(),
      },
      {
        status: "ok",
        action: "enable",
        code: "enabled",
        contribution: unavailableStatus(),
      },
      {
        status: "error",
        action: "enable",
        code: "enabled",
        contribution: activeStatus(),
      },
      {
        status: "ok",
        action: "stop",
        code: "stopped",
        contribution: {
          ...activeStatus(),
          state: "off",
          enabled: false,
          canPreview: true,
          canStop: false,
          canDelete: false,
        },
      },
    ]) {
      expect(() => parseContributionAction(candidate)).toThrow(
        "Invalid contribution action",
      );
    }

    expect(
      parseContributionAction({
        status: "ok",
        action: "recover",
        code: "stopped",
        contribution: {
          ...activeStatus(),
          state: "stopped",
          enabled: false,
          canPreview: true,
          canStop: false,
          canDelete: true,
        },
      }),
    ).toMatchObject({ status: "ok", action: "recover", code: "stopped" });
  });

  it("uses only the fixed same-origin endpoints and exact confirmations", async () => {
    const calls: Request[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(
        new URL(String(input), "http://127.0.0.1:4000"),
        init,
      );
      calls.push(request.clone());
      if (request.url.endsWith(CONTRIBUTION_STATUS_ENDPOINT)) {
        return response(unavailableStatus());
      }
      if (request.url.endsWith(CONTRIBUTION_PREVIEW_ENDPOINT)) {
        return response({ status: "ok", preview: preview() });
      }
      return response({
        status: "ok",
        action: "enable",
        code: "enabled",
        contribution: activeStatus(),
      });
    });

    await requestContributionStatus(fetcher);
    await requestContributionPreview(fetcher);
    await requestContributionAction("enable", PREVIEW_ID, fetcher);

    expect(calls.map((request) => new URL(request.url).pathname)).toEqual([
      CONTRIBUTION_STATUS_ENDPOINT,
      CONTRIBUTION_PREVIEW_ENDPOINT,
      CONTRIBUTION_ENABLE_ENDPOINT,
    ]);
    expect(await calls[1]!.text()).toBe(
      JSON.stringify({ confirmation: "preview-contribution-data" }),
    );
    expect(await calls[2]!.text()).toBe(
      JSON.stringify({
        previewId: PREVIEW_ID,
        confirmation: "enable-anonymous-contribution",
      }),
    );
    expect(
      calls.every((request) => request.credentials === "same-origin"),
    ).toBe(true);
    expect(calls.every((request) => request.redirect === "error")).toBe(true);
  });

  it.each([
    ["enable", "off"],
    ["enable", "stopped"],
    ["delete", "active"],
    ["delete", "stopped"],
  ] as const)(
    "polls past a stale first GET after a lost %s response from %s",
    async (action, priorState) => {
      const previous = parseContributionStatus(
        priorState === "active"
          ? activeStatus()
          : {
              ...activeStatus(),
              state: priorState,
              enabled: false,
              canPreview: true,
              canStop: false,
              canDelete: priorState === "stopped",
            },
      );
      const converged =
        action === "enable"
          ? activeStatus()
          : {
              ...activeStatus(),
              state: "deletion-pending",
              enabled: false,
              canPreview: false,
              canStop: false,
              canDelete: false,
              canRecover: true,
              deletionStatus: "queued",
              anonymousHistoricalTotalsRetained: true,
            };
      let statusReads = 0;
      const paths: string[] = [];
      const fetcher = vi.fn<typeof fetch>(async (input) => {
        const path = new URL(String(input), "http://127.0.0.1:4000").pathname;
        paths.push(path);
        if (path !== CONTRIBUTION_STATUS_ENDPOINT) {
          throw new TypeError("RESPONSE_LOST");
        }
        statusReads += 1;
        return response(statusReads === 1 ? previous : converged);
      });

      const attempt = await requestContributionActionWithStatusRecovery(
        action,
        action === "enable" ? PREVIEW_ID : null,
        fetcher,
        undefined,
        AbortSignal.timeout(1_000),
        previous,
      );
      expect(attempt).toMatchObject({
        result: null,
        contribution: {
          state: action === "enable" ? "active" : "deletion-pending",
        },
      });
      expect(contributionActionAttemptSucceeded(attempt)).toBe(true);
      expect(paths).toEqual([
        action === "enable"
          ? CONTRIBUTION_ENABLE_ENDPOINT
          : CONTRIBUTION_DELETE_ENDPOINT,
        CONTRIBUTION_STATUS_ENDPOINT,
        CONTRIBUTION_STATUS_ENDPOINT,
      ]);
    },
  );
});
