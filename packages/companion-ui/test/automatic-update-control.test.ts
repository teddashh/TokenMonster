import { describe, expect, it, vi } from "vitest";

import {
  automaticUpdateBridge,
  automaticUpdateStatusText,
  parseAutomaticUpdateStatus,
  readAutomaticUpdateStatus,
  requestAutomaticUpdateCheck,
  requestAutomaticUpdateInstall,
  saveAutomaticUpdatePreference,
  type AutomaticUpdateStatus,
} from "../src/public/automatic-update-control.js";
import type { TokenMonsterCompanionBridge } from "../src/public/share-card.js";

function status(
  overrides: Partial<AutomaticUpdateStatus["update"]> = {},
): AutomaticUpdateStatus {
  return Object.freeze({
    contractVersion: 1,
    revision: "0",
    preferenceStorage: "ready",
    automaticChecksEnabled: false,
    update: Object.freeze({
      contractVersion: 1,
      currentVersion: "0.1.0",
      channel: "latest",
      status: "idle",
      lastCheckedAt: null,
      availableVersion: null,
      errorCode: null,
      ...overrides,
    }),
  });
}

function bridge(
  overrides: Partial<TokenMonsterCompanionBridge> = {},
): TokenMonsterCompanionBridge {
  return {
    savePng: vi.fn(),
    getAutomaticUpdateStatus: vi.fn(async () => status()),
    updateAutomaticChecks: vi.fn(async () => ({ ok: true, status: status() })),
    checkForAutomaticUpdate: vi.fn(async () => ({
      ok: true,
      code: "check-started",
      status: status({
        status: "checking",
        lastCheckedAt: "2026-07-18T12:34:56.000Z",
      }),
    })),
    installAutomaticUpdate: vi.fn(async () => ({
      ok: false,
      code: "not-ready",
      status: status(),
    })),
    ...overrides,
  };
}

describe("Electron automatic update control", () => {
  it("appears only when the complete fixed command bridge is present", () => {
    expect(automaticUpdateBridge(undefined)).toBeNull();
    expect(
      automaticUpdateBridge({ savePng: vi.fn() } as TokenMonsterCompanionBridge),
    ).toBeNull();
    expect(automaticUpdateBridge(bridge())).toMatchObject({
      getAutomaticUpdateStatus: expect.any(Function),
      updateAutomaticChecks: expect.any(Function),
      checkForAutomaticUpdate: expect.any(Function),
      installAutomaticUpdate: expect.any(Function),
    });
  });

  it("strictly parses service and updater states", () => {
    expect(parseAutomaticUpdateStatus(status())).toEqual(status());
    expect(() =>
      parseAutomaticUpdateStatus({ ...status(), rawError: "/private/path" }),
    ).toThrow("Invalid automatic update status");
    expect(() =>
      parseAutomaticUpdateStatus(
        status({ status: "error", errorCode: null }),
      ),
    ).toThrow("Invalid automatic update state");
    expect(() =>
      parseAutomaticUpdateStatus(
        status({
          status: "ready",
          availableVersion: "0.1.0-rc.01",
        }),
      ),
    ).toThrow("Invalid automatic update state");
    for (const currentVersion of [
      "1.2.3-beta2",
      "1.2.3-beta.1.2",
      "65536.0.0",
      "1.2.3-beta.65536",
    ]) {
      expect(() =>
        parseAutomaticUpdateStatus({
          ...status(),
          update: { ...status().update, currentVersion },
        }),
      ).toThrow("Invalid automatic update state");
    }
  });

  it("normalizes the preference request and rejects renderer-controlled extras", async () => {
    const updateAutomaticChecks = vi.fn(async () => ({
      ok: true,
      status: Object.freeze({
        ...status(),
        revision: "1",
        automaticChecksEnabled: true,
      }),
    }));
    const localBridge = automaticUpdateBridge(
      bridge({ updateAutomaticChecks }),
    );
    if (localBridge === null) throw new Error("missing update bridge");

    await expect(
      saveAutomaticUpdatePreference(localBridge, {
        expectedRevision: "0",
        automaticChecksEnabled: true,
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: { revision: "1", automaticChecksEnabled: true },
    });
    expect(updateAutomaticChecks).toHaveBeenCalledWith({
      expectedRevision: "0",
      automaticChecksEnabled: true,
    });
    await expect(
      saveAutomaticUpdatePreference(localBridge, {
        expectedRevision: "0",
        automaticChecksEnabled: true,
        feedUrl: "https://attacker.invalid/",
      } as never),
    ).rejects.toThrow("Invalid automatic update preference");
    expect(updateAutomaticChecks).toHaveBeenCalledTimes(1);
  });

  it("validates status, manual check, and install responses independently", async () => {
    const localBridge = automaticUpdateBridge(bridge());
    if (localBridge === null) throw new Error("missing update bridge");
    await expect(readAutomaticUpdateStatus(localBridge)).resolves.toEqual(
      status(),
    );
    await expect(requestAutomaticUpdateCheck(localBridge)).resolves.toMatchObject(
      { ok: true, code: "check-started" },
    );
    await expect(
      requestAutomaticUpdateInstall(localBridge),
    ).resolves.toMatchObject({ ok: false, code: "not-ready" });

    const malformed = automaticUpdateBridge(
      bridge({
        checkForAutomaticUpdate: vi.fn(async () => ({
          ok: false,
          code: "check-started",
          status: status(),
        })),
      }),
    );
    if (malformed === null) throw new Error("missing malformed bridge");
    await expect(requestAutomaticUpdateCheck(malformed)).rejects.toThrow(
      "Invalid automatic update command",
    );
  });

  it("renders every public phase without exposing updater details", () => {
    expect(automaticUpdateStatusText(status())).toContain("只有按下手動檢查");
    expect(
      automaticUpdateStatusText(
        Object.freeze({ ...status(), automaticChecksEnabled: true }),
      ),
    ).toContain("自動檢查已開啟");
    expect(
      automaticUpdateStatusText(status({ status: "unsupported" })),
    ).toContain("不支援");
    expect(
      automaticUpdateStatusText(status({ status: "checking" })),
    ).toContain("正在安全地檢查");
    expect(
      automaticUpdateStatusText(
        status({ status: "downloading", availableVersion: "0.2.0" }),
      ),
    ).toContain("正在背景下載");
    expect(
      automaticUpdateStatusText(
        status({ status: "ready", availableVersion: "0.2.0" }),
      ),
    ).toContain("0.2.0");
    const rendered = automaticUpdateStatusText(
      status({ status: "error", errorCode: "check-failed" }),
    );
    expect(rendered).toContain("沒有完成");
    expect(rendered).not.toContain("check-failed");
  });
});
