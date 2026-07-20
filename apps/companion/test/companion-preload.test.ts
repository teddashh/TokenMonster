import Module, { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import {
  COMPANION_PNG_SAVE_CHANNEL,
  COMPANION_PNG_SUGGESTED_NAME,
  type CompanionPngSaveRequest,
  type TokenMonsterCompanionBridge
} from "../src/shared/companion-png.js";
import {
  REMINDER_IPC_CHANNELS,
  type ReminderMutationResult,
  type ReminderServiceStatus,
  type ReminderSettingsRequest,
  type ReminderTestResult
} from "../src/shared/reminders.js";
import {
  AUTOMATIC_UPDATE_IPC_CHANNELS,
  type AutomaticUpdatePreferenceMutationResult,
  type AutomaticUpdatePreferenceRequest,
  type AutomaticUpdateServiceCommandResult,
  type AutomaticUpdateServiceStatus
} from "../src/shared/automatic-updates.js";

import { companionPngFixture } from "./companion-png-fixture.js";

const require = createRequire(import.meta.url);

interface LoadableModule {
  _load(
    request: string,
    parent: NodeModule | undefined,
    isMain: boolean
  ): unknown;
}

describe("companion preload", () => {
  it("normalizes renderer-realm PNG bytes before invoking the exact IPC", async () => {
    const png = companionPngFixture();
    const rendererRequest = runInNewContext(
      "({ bytes: new Uint8Array(values), suggestedName: name })",
      {
        values: [...png],
        name: COMPANION_PNG_SUGGESTED_NAME
      }
    ) as CompanionPngSaveRequest;
    expect(rendererRequest.bytes).not.toBeInstanceOf(Uint8Array);

    let exposedName: string | undefined;
    let exposedBridge: TokenMonsterCompanionBridge | undefined;
    const calls: Array<readonly [string, unknown?]> = [];
    let response: unknown = Object.freeze({ status: "saved" });
    let pendingResolve: ((value: unknown) => void) | undefined;
    const electronMock = Object.freeze({
      contextBridge: Object.freeze({
        exposeInMainWorld(
          name: string,
          bridge: TokenMonsterCompanionBridge
        ): void {
          exposedName = name;
          exposedBridge = bridge;
        }
      }),
      ipcRenderer: Object.freeze({
        invoke(
          channel: string,
          request?: unknown
        ): Promise<unknown> {
          calls.push([channel, request]);
          if (response === "pending") {
            return new Promise<unknown>((resolve) => {
              pendingResolve = resolve;
            });
          }
          return Promise.resolve(response);
        }
      })
    });
    const loadableModule = Module as unknown as LoadableModule;
    const originalLoad = loadableModule._load;
    try {
      loadableModule._load = function loadWithElectronMock(
        request,
        parent,
        isMain
      ) {
        return request === "electron"
          ? electronMock
          : originalLoad.call(this, request, parent, isMain);
      };
      require("../dist/main/preload/companion.cjs");
    } finally {
      loadableModule._load = originalLoad;
    }

    expect(exposedName).toBe("tokenMonsterCompanion");
    if (exposedBridge === undefined) throw new Error("bridge not exposed");
    const bridge: TokenMonsterCompanionBridge = exposedBridge;
    expect(Object.isFrozen(bridge)).toBe(true);
    expect(Object.keys(bridge)).toEqual([
      "savePng",
      "getReminderStatus",
      "updateReminderSettings",
      "testReminder",
      "getAutomaticUpdateStatus",
      "updateAutomaticChecks",
      "checkForAutomaticUpdate",
      "installAutomaticUpdate"
    ]);

    const saved = await bridge.savePng(rendererRequest);
    expect(saved).toEqual({ status: "saved" });
    expect(Object.isFrozen(saved)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(COMPANION_PNG_SAVE_CHANNEL);
    const normalizedPngRequest = calls[0]?.[1] as CompanionPngSaveRequest;
    expect(normalizedPngRequest.suggestedName).toBe(
      COMPANION_PNG_SUGGESTED_NAME
    );
    expect(normalizedPngRequest.bytes).toBeInstanceOf(Uint8Array);
    expect(Object.getPrototypeOf(normalizedPngRequest.bytes)).toBe(
      Uint8Array.prototype
    );
    expect(normalizedPngRequest.bytes).toEqual(png);
    expect(normalizedPngRequest.bytes).not.toBe(rendererRequest.bytes);

    await expect(
      bridge.savePng({
        bytes: png,
        suggestedName: "other.png" as typeof COMPANION_PNG_SUGGESTED_NAME
      })
    ).rejects.toThrow("IPC_REQUEST_REJECTED");
    await expect(
      bridge.savePng({
        bytes: Buffer.from(png),
        suggestedName: COMPANION_PNG_SUGGESTED_NAME
      })
    ).rejects.toThrow("IPC_REQUEST_REJECTED");
    expect(calls).toHaveLength(1);

    response = Object.freeze({ status: "saved", extra: true });
    await expect(bridge.savePng(rendererRequest)).rejects.toThrow(
      "IPC_RESPONSE_REJECTED"
    );
    expect(calls).toHaveLength(2);

    response = "pending";
    const first = bridge.savePng(rendererRequest);
    await Promise.resolve();
    await expect(bridge.savePng(rendererRequest)).rejects.toThrow(
      "IPC_REQUEST_BUSY"
    );
    pendingResolve?.(Object.freeze({ status: "saved" }));
    await expect(first).resolves.toEqual({ status: "saved" });
    expect(calls).toHaveLength(3);

    const disabledReminderStatus: ReminderServiceStatus = Object.freeze({
      contractVersion: 1,
      revision: "0",
      storage: "ready",
      notificationSupported: true,
      enabled: false,
      dailySummaryTime: "18:00",
      quietHours: Object.freeze({ start: "22:00", end: "08:00" }),
      scheduled: false,
      nextCheckAt: null,
      lastHandledLocalDate: null
    });
    const enabledReminderStatus: ReminderServiceStatus = Object.freeze({
      ...disabledReminderStatus,
      revision: "1",
      enabled: true,
      scheduled: true,
      nextCheckAt: "2026-07-18T18:01:00.000Z"
    });

    response = disabledReminderStatus;
    const readStatus = await bridge.getReminderStatus();
    expect(readStatus).toEqual(disabledReminderStatus);
    expect(Object.isFrozen(readStatus)).toBe(true);
    expect(Object.isFrozen(readStatus.quietHours)).toBe(true);
    expect(calls.at(-1)).toEqual([REMINDER_IPC_CHANNELS.status, undefined]);

    const rendererReminderRequest = runInNewContext(
      "({ expectedRevision: '0', enabled: true, dailySummaryTime: '18:00', quietHours: { start: '22:00', end: '08:00' } })"
    ) as ReminderSettingsRequest;
    expect(rendererReminderRequest).not.toBeInstanceOf(Object);
    response = Object.freeze({
      ok: true,
      status: enabledReminderStatus
    }) satisfies ReminderMutationResult;
    await expect(
      bridge.updateReminderSettings(rendererReminderRequest)
    ).resolves.toEqual({ ok: true, status: enabledReminderStatus });
    expect(calls.at(-1)).toEqual([
      REMINDER_IPC_CHANNELS.update,
      {
        expectedRevision: "0",
        enabled: true,
        dailySummaryTime: "18:00",
        quietHours: { start: "22:00", end: "08:00" }
      }
    ]);
    const callsAfterReminderUpdate = calls.length;
    await expect(
      bridge.updateReminderSettings({
        ...rendererReminderRequest,
        extra: true
      } as ReminderSettingsRequest)
    ).rejects.toThrow("IPC_REQUEST_REJECTED");
    await expect(
      bridge.updateReminderSettings({
        ...rendererReminderRequest,
        dailySummaryTime: "24:00"
      })
    ).rejects.toThrow("IPC_REQUEST_REJECTED");
    expect(calls).toHaveLength(callsAfterReminderUpdate);

    response = Object.freeze({ ok: true, status: enabledReminderStatus, extra: true });
    await expect(
      bridge.updateReminderSettings(rendererReminderRequest)
    ).rejects.toThrow("IPC_RESPONSE_REJECTED");

    response = "pending";
    const pendingTest = bridge.testReminder();
    await Promise.resolve();
    await expect(
      bridge.updateReminderSettings(rendererReminderRequest)
    ).rejects.toThrow("IPC_REQUEST_BUSY");
    pendingResolve?.(
      Object.freeze({
        outcome: "shown",
        status: disabledReminderStatus
      }) satisfies ReminderTestResult
    );
    await expect(pendingTest).resolves.toEqual({
      outcome: "shown",
      status: disabledReminderStatus
    });
    expect(calls.at(-1)?.[0]).toBe(REMINDER_IPC_CHANNELS.test);

    response = Object.freeze({ ...disabledReminderStatus, extra: true });
    await expect(bridge.getReminderStatus()).rejects.toThrow(
      "IPC_RESPONSE_REJECTED"
    );

    const automaticUpdateStatus: AutomaticUpdateServiceStatus = Object.freeze({
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
        errorCode: null
      })
    });
    const enabledAutomaticUpdateStatus: AutomaticUpdateServiceStatus =
      Object.freeze({
        ...automaticUpdateStatus,
        revision: "1",
        automaticChecksEnabled: true
      });

    response = automaticUpdateStatus;
    await expect(bridge.getAutomaticUpdateStatus()).resolves.toEqual(
      automaticUpdateStatus
    );
    expect(calls.at(-1)).toEqual([
      AUTOMATIC_UPDATE_IPC_CHANNELS.status,
      undefined
    ]);

    const rendererAutomaticUpdateRequest = runInNewContext(
      "({ expectedRevision: '0', automaticChecksEnabled: true })"
    ) as AutomaticUpdatePreferenceRequest;
    expect(rendererAutomaticUpdateRequest).not.toBeInstanceOf(Object);
    response = Object.freeze({
      ok: true,
      status: enabledAutomaticUpdateStatus
    }) satisfies AutomaticUpdatePreferenceMutationResult;
    await expect(
      bridge.updateAutomaticChecks(rendererAutomaticUpdateRequest)
    ).resolves.toMatchObject({
      ok: true,
      status: { revision: "1", automaticChecksEnabled: true }
    });
    expect(calls.at(-1)).toEqual([
      AUTOMATIC_UPDATE_IPC_CHANNELS.preference,
      { expectedRevision: "0", automaticChecksEnabled: true }
    ]);
    const callsAfterAutomaticPreference = calls.length;
    await expect(
      bridge.updateAutomaticChecks({
        ...rendererAutomaticUpdateRequest,
        feedUrl: "https://attacker.invalid/"
      } as AutomaticUpdatePreferenceRequest)
    ).rejects.toThrow("IPC_REQUEST_REJECTED");
    expect(calls).toHaveLength(callsAfterAutomaticPreference);

    const checkingAutomaticUpdateStatus: AutomaticUpdateServiceStatus =
      Object.freeze({
        ...enabledAutomaticUpdateStatus,
        update: Object.freeze({
          ...enabledAutomaticUpdateStatus.update,
          status: "checking",
          lastCheckedAt: "2026-07-18T12:34:56.000Z"
        })
      });
    response = Object.freeze({
      ok: true,
      code: "check-started",
      status: checkingAutomaticUpdateStatus
    }) satisfies AutomaticUpdateServiceCommandResult;
    await expect(bridge.checkForAutomaticUpdate()).resolves.toMatchObject({
      ok: true,
      code: "check-started",
      status: { update: { status: "checking" } }
    });
    expect(calls.at(-1)).toEqual([
      AUTOMATIC_UPDATE_IPC_CHANNELS.check,
      undefined
    ]);

    response = "pending";
    const pendingInstall = bridge.installAutomaticUpdate();
    await Promise.resolve();
    await expect(bridge.checkForAutomaticUpdate()).rejects.toThrow(
      "IPC_REQUEST_BUSY"
    );
    pendingResolve?.(
      Object.freeze({
        ok: false,
        code: "not-ready",
        status: enabledAutomaticUpdateStatus
      }) satisfies AutomaticUpdateServiceCommandResult
    );
    await expect(pendingInstall).resolves.toMatchObject({
      ok: false,
      code: "not-ready"
    });
    expect(calls.at(-1)?.[0]).toBe(AUTOMATIC_UPDATE_IPC_CHANNELS.install);

    response = Object.freeze({
      ...automaticUpdateStatus,
      rawError: "PRIVATE_UPDATER_CANARY"
    });
    await expect(bridge.getAutomaticUpdateStatus()).rejects.toThrow(
      "IPC_RESPONSE_REJECTED"
    );
  });
});
