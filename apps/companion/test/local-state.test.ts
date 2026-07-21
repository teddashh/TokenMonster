import { afterEach, describe, expect, it, vi } from "vitest";

import {
  openLocalStore,
  type LocalStore
} from "@tokenmonster/local-store";

import {
  initializeLocalConfig,
  localRuntimeStatus,
  resolveCompanionTimezone,
  saveSelectedCharacter,
  stopContributionForLocalSourceReset
} from "../src/main/local-state.js";

let store: LocalStore | null = null;

afterEach(() => {
  store?.close();
  store = null;
});

describe("companion local state", () => {
  it("creates a content-blind default config with a safe timezone fallback", async () => {
    store = await openLocalStore({ path: ":memory:" });
    const config = initializeLocalConfig(store, "../../PRIVATE_PATH");

    expect(config).toEqual({
      schemaVersion: "1",
      locale: "zh-TW",
      timezone: "UTC",
      selectedCharacterId: "chatgpt",
      collectionIntervalMinutes: 30,
      startAtLogin: false,
      animationsEnabled: true
    });
    expect(resolveCompanionTimezone("America/New_York")).toBe(
      "America/New_York"
    );
  });

  it("restores config and persists only a stable character ID", async () => {
    store = await openLocalStore({ path: ":memory:" });
    initializeLocalConfig(store, "UTC");
    expect(saveSelectedCharacter(store, "gemini").selectedCharacterId).toBe(
      "gemini"
    );
    expect(initializeLocalConfig(store, "Asia/Taipei").timezone).toBe("UTC");
    expect(JSON.stringify(store.getConfig())).not.toMatch(
      /apiKey|prompt|response|path/i
    );
  });

  it("projects only bounded diagnostic counts and authority state", async () => {
    store = await openLocalStore({ path: ":memory:" });
    expect(localRuntimeStatus(store, null)).toEqual({
      storage: "ready",
      state: "not-configured",
      dailyAggregateRows: 0,
      lastSuccessfulScanAt: null
    });
    store.setCollectorAuthority({
      kind: "tokscale",
      state: "running",
      adapterVersion: "0.1.0",
      sourceVersion: "4.5.2"
    });
    expect(
      localRuntimeStatus(store, "2026-07-15T18:30:00.000Z")
    ).toMatchObject({
      state: "running",
      dailyAggregateRows: 0,
      lastSuccessfulScanAt: "2026-07-15T18:30:00.000Z"
    });
  });

  it("requires a verified hard contribution stop before collector-source reset", async () => {
    const stoppedStatus = {
      configured: true,
      secureStorage: "os-backed" as const,
      state: "stopped" as const,
      enabled: false,
      canEnable: false,
      canDelete: true,
      canRecover: false,
      outboxPending: 0,
      consentDocumentRevision: null,
      deletion: null
    };
    const stop = vi.fn(async () => ({
      ok: true,
      code: "stopped" as const,
      status: stoppedStatus
    }));
    await expect(
      stopContributionForLocalSourceReset({ stop })
    ).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledOnce();

    await expect(
      stopContributionForLocalSourceReset({
        stop: async () => ({
          ok: false,
          code: "secure-storage-failed",
          status: {
            ...stoppedStatus,
            state: "active",
            enabled: true,
            outboxPending: 1
          }
        })
      })
    ).rejects.toThrow("CONTRIBUTION_STOP_FAILED");
  });
});
