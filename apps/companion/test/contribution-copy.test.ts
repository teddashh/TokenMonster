import { describe, expect, it } from "vitest";

import type { ContributionRuntimeStatus } from "../src/shared/ipc.js";
import {
  contributionScanCopy,
  contributionTopbarCopy
} from "../src/renderer/src/contribution-copy.js";

function status(
  state: ContributionRuntimeStatus["state"]
): ContributionRuntimeStatus {
  return {
    configured: state !== "unavailable",
    secureStorage: state === "unavailable" ? "unavailable" : "os-backed",
    state,
    enabled: state === "active",
    canEnable: state === "off" || state === "deletion-complete",
    canDelete: state === "active" || state === "stopped",
    outboxPending: 0,
    consentDocumentRevision: state === "active" ? "contribution-2026-07-15" : null,
    deletion: null
  };
}

describe("truthful contribution UI copy", () => {
  it("distinguishes every runtime state without claiming enrollment already uploaded", () => {
    expect(contributionTopbarCopy(status("off"), "local-only")).toBe(
      "本機統計 · 雲端貢獻關閉（預設）"
    );
    expect(contributionTopbarCopy(status("active"), "local-only")).toBe(
      "本機統計 · 自願貢獻已啟用（背景同步）"
    );
    expect(contributionTopbarCopy(status("stopped"), "local-only")).toBe(
      "本機統計 · 後續雲端上傳已停止"
    );
    expect(
      contributionTopbarCopy(status("deletion-pending"), "local-only")
    ).toContain("刪除中");
    expect(
      contributionTopbarCopy(status("deletion-complete"), "local-only")
    ).toContain("已刪除");
    expect(
      contributionTopbarCopy(status("deletion-failed"), "local-only")
    ).toContain("刪除失敗");
    expect(contributionTopbarCopy(status("unavailable"), "local-only")).toBe(
      "本機統計 · 雲端貢獻安全停用"
    );
  });

  it("reports BYOK independently and never treats scan as an upload", () => {
    expect(contributionTopbarCopy(status("stopped"), "byok-direct")).toBe(
      "本機統計 · BYOK 直連 OpenAI · 後續雲端上傳已停止"
    );
    for (const state of [
      "off",
      "active",
      "stopped",
      "deletion-pending",
      "deletion-complete",
      "deletion-failed",
      "unavailable"
    ] as const) {
      expect(contributionScanCopy(state)).toContain("本次掃描只更新本機");
    }
  });
});
