import { describe, expect, it, vi } from "vitest";

import {
  CHARACTER_ASSET_PACK_CONSENT_ENDPOINT,
  CHARACTER_ASSET_PACK_STATUS_ENDPOINT,
  characterAssetPackControlMode,
  parseCharacterAssetPackStatus,
  requestCharacterAssetPackStatus,
  settleCharacterAssetPackConsent,
  updateCharacterAssetPackConsent,
} from "../src/public/app.js";

const AVAILABLE = Object.freeze({
  status: "ok" as const,
  phase: "available" as const,
  consented: false,
  enabled: false,
  releaseId: "glm-2026.07.18",
  downloadBytes: 5_238_148,
  lastError: null,
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fixed character asset pack client contract", () => {
  it("keeps destructive removal secondary and avoids duplicate cleanup actions", () => {
    expect(characterAssetPackControlMode(AVAILABLE)).toEqual({
      primaryAction: "enable",
      showRevoke: false,
    });
    expect(
      characterAssetPackControlMode({
        ...AVAILABLE,
        phase: "installed",
        consented: true,
        enabled: true,
      }),
    ).toEqual({ primaryAction: null, showRevoke: true });
    expect(
      characterAssetPackControlMode({
        ...AVAILABLE,
        phase: "repair-needed",
        consented: true,
        lastError: "download-failed",
      }),
    ).toEqual({ primaryAction: "repair", showRevoke: true });
    expect(
      characterAssetPackControlMode({
        ...AVAILABLE,
        phase: "repair-needed",
        lastError: "cache-unavailable",
      }),
    ).toEqual({ primaryAction: "cleanup", showRevoke: false });
  });

  it("accepts only exact internally consistent status DTOs", () => {
    expect(parseCharacterAssetPackStatus(AVAILABLE)).toEqual(AVAILABLE);
    expect(
      parseCharacterAssetPackStatus({
        ...AVAILABLE,
        phase: "installed",
        consented: true,
        enabled: true,
      }),
    ).toMatchObject({ phase: "installed", consented: true, enabled: true });
    expect(
      parseCharacterAssetPackStatus({
        ...AVAILABLE,
        phase: "repair-needed",
        consented: true,
        lastError: "download-failed",
      }),
    ).toMatchObject({ phase: "repair-needed", enabled: false });
    expect(
      parseCharacterAssetPackStatus({
        ...AVAILABLE,
        phase: "repair-needed",
        consented: false,
        lastError: "cache-unavailable",
      }),
    ).toMatchObject({
      phase: "repair-needed",
      consented: false,
      enabled: false,
    });
  });

  it.each([
    ["unknown key", { ...AVAILABLE, usage: 1 }],
    ["enabled before install", { ...AVAILABLE, enabled: true }],
    [
      "installed without consent",
      { ...AVAILABLE, phase: "installed", enabled: true },
    ],
    [
      "unavailable with release metadata",
      { ...AVAILABLE, phase: "unavailable" },
    ],
    ["unsafe release ID", { ...AVAILABLE, releaseId: "GLM/private" }],
    ["unbounded bytes", { ...AVAILABLE, downloadBytes: 999_999_999 }],
    ["raw error text", { ...AVAILABLE, lastError: "private upstream text" }],
    [
      "cleanup repair without a cleanup error",
      { ...AVAILABLE, phase: "repair-needed" },
    ],
  ])("rejects %s", (_label, value) => {
    expect(() => parseCharacterAssetPackStatus(value)).toThrow(TypeError);
  });

  it("uses a local status read and one boolean-only consent mutation", async () => {
    const fetcher = vi.fn(async () => jsonResponse(AVAILABLE));

    await expect(requestCharacterAssetPackStatus(fetcher)).resolves.toEqual(
      AVAILABLE,
    );
    await expect(
      updateCharacterAssetPackConsent(true, fetcher),
    ).resolves.toEqual(AVAILABLE);

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      CHARACTER_ASSET_PACK_STATUS_ENDPOINT,
      expect.objectContaining({
        method: "GET",
        credentials: "same-origin",
        redirect: "error",
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      CHARACTER_ASSET_PACK_CONSENT_ENDPOINT,
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        redirect: "error",
        body: '{"enabled":true}',
      }),
    );
  });

  it("re-reads authoritative state when a committed mutation loses its response", async () => {
    const installed = {
      ...AVAILABLE,
      phase: "installed" as const,
      consented: true,
      enabled: true,
    };
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("response connection closed"))
      .mockResolvedValueOnce(jsonResponse(installed));

    await expect(
      settleCharacterAssetPackConsent(true, fetcher),
    ).resolves.toEqual({
      status: installed,
      responseRecovered: true,
      mutationObserved: true,
    });
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      CHARACTER_ASSET_PACK_CONSENT_ENDPOINT,
      expect.objectContaining({ method: "POST", body: '{"enabled":true}' }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      CHARACTER_ASSET_PACK_STATUS_ENDPOINT,
      expect.objectContaining({ method: "GET", signal: expect.any(AbortSignal) }),
    );
  });

  it("does not call an unchanged recovery read a successful mutation", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("request never reached loopback"))
      .mockResolvedValueOnce(jsonResponse(AVAILABLE));

    await expect(
      settleCharacterAssetPackConsent(true, fetcher),
    ).resolves.toEqual({
      status: AVAILABLE,
      responseRecovered: true,
      mutationObserved: false,
    });
  });

  it("confirms a recovered revoke only after consent is observably off", async () => {
    const installed = {
      ...AVAILABLE,
      phase: "installed" as const,
      consented: true,
      enabled: true,
    };
    const unchangedFetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("request never reached loopback"))
      .mockResolvedValueOnce(jsonResponse(installed));
    await expect(
      settleCharacterAssetPackConsent(false, unchangedFetcher),
    ).resolves.toMatchObject({
      status: installed,
      responseRecovered: true,
      mutationObserved: false,
    });

    const committedFetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("response connection closed"))
      .mockResolvedValueOnce(jsonResponse(AVAILABLE));
    await expect(
      settleCharacterAssetPackConsent(false, committedFetcher),
    ).resolves.toMatchObject({
      status: AVAILABLE,
      responseRecovered: true,
      mutationObserved: true,
    });

    const cleanupStillNeeded = {
      ...AVAILABLE,
      phase: "repair-needed" as const,
      lastError: "cache-unavailable" as const,
    };
    const cleanupFetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("request never reached loopback"))
      .mockResolvedValueOnce(jsonResponse(cleanupStillNeeded));
    await expect(
      settleCharacterAssetPackConsent(false, cleanupFetcher),
    ).resolves.toMatchObject({
      status: cleanupStillNeeded,
      responseRecovered: true,
      mutationObserved: false,
    });
  });

  it("surfaces failure when both the mutation response and recovery read fail", async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError("loopback unavailable");
    });

    await expect(
      settleCharacterAssetPackConsent(false, fetcher, undefined, 10),
    ).rejects.toThrow("loopback unavailable");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
